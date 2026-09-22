require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const app = require('./app.js');
const connectDB = require('./config/database.js');
const logger = require('./utils/logger.js');
const mongoose = require('mongoose');
const socketAuth = require('./middleware/socketAuth.js');
const { startShiftScheduler } = require('./utils/shiftScheduler.js');
const allowedOrigins = require('./config/allowedOrigins.js');
const backfillWalkIn = require('./utils/backfillWalkIn.js');
const { acquireJobLock, releaseJobLock, withJobLock } = require('./utils/jobLock.js');
const PaystackTransaction = require('./models/PaystackTransaction.js');
// Needed to authorize socket room joins — a room join grants a live feed of the
// same data the REST endpoints guard, so it has to check the same things.
const Order = require('./models/Order.js');
const ChatThread = require('./models/ChatThread.js');
const { customerCanAccessOrder } = require('./utils/customerIdentity.js');
const {
  backgroundVerifyAndCredit,
  paystackRequest,
  processSuccessfulPaystackPayment,
} = require('./controllers/paymentController.js');


// Connect to database
connectDB();

const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Socket.io setup for real-time updates
// Use the same allowed-origins list as the REST API so any front-end origin
// that can make HTTP requests can also open a WebSocket connection.
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const normalizedOrigin = origin ? origin.replace(/\/$/, '') : origin;
      if (allowedOrigins.indexOf(normalizedOrigin) !== -1 || !origin) {
        callback(null, true);
      } else {
        callback(new Error(`Socket CORS: origin not allowed — ${origin}`));
      }
    },
    credentials: true,
  },
});

// Socket.io authentication middleware
io.use(socketAuth);

// Socket.io connection (after authentication)
io.on('connection', (socket) => {
  const userId = socket.userId;
  const customerId = socket.customerId;
  const userName = socket.user.name;

  logger.info(`✅ User connected: ${userName} (User ID: ${userId}, Customer ID: ${customerId || 'N/A'}, Socket ID: ${socket.id})`);

  // Automatically join user's personal room
  if (userId) {
    socket.join(`user-${userId}`);
    logger.info(`Auto-joined user room: user-${userId}`);
  }

  // Automatically join customer's personal room if they have a customer ID
  if (customerId) {
    socket.join(`user-${customerId}`);
    logger.info(`Auto-joined customer room: user-${customerId}`);
  }

  // Admin/manager/staff/receptionist automatically join the 'admin' broadcast room
  const staffRoles = ['admin', 'manager', 'staff', 'receptionist'];
  if (staffRoles.includes(socket.user.role)) {
    socket.join('admin');
    logger.info(`Auto-joined admin room: ${socket.user.role} ${userName}`);
  }

  // Delivery agents join the 'delivery' broadcast room so they receive
  // real-time notifications about new delivery orders and ready-for-delivery orders.
  if (socket.user.role === 'delivery') {
    socket.join('delivery');
    logger.info(`Auto-joined delivery room: ${userName}`);
  }

  // ── Room authorization ─────────────────────────────────────────────────────
  // These three handlers used to join whatever room they were handed, with no
  // check of any kind. A customer could emit join-payments and receive every
  // payment event in the business, or join-order / join-chat with any id and
  // watch another customer's order or read their support conversation. The
  // rules below mirror the REST equivalents exactly: getPayments is
  // admin/manager, getOrder allows the customer's account or linked customer
  // record, and getChatThread compares customerId.
  const STAFF_ROLES = ['staff', 'admin', 'manager', 'receptionist', 'developer'];
  const isStaff = STAFF_ROLES.includes(socket.user.role);

  // Denials are reported back so the client can surface a real message instead
  // of silently receiving nothing.
  const deny = (room, reason) => {
    logger.warn(`Socket room denied: ${userName} (${socket.user.role}) → ${room} — ${reason}`);
    socket.emit('room:denied', { room, reason });
  };

  // Join payments room — admin/manager only, matching GET /payments.
  socket.on('join-payments', () => {
    if (!['admin', 'manager', 'developer'].includes(socket.user.role)) {
      return deny('payments', 'Not authorized to view payment activity');
    }
    socket.join('payments');
    logger.info(`${userName} joined payments room`);
  });

  socket.on('leave-payments', () => {
    socket.leave('payments');
    logger.info(`${userName} left payments room`);
  });

  // Join order room — staff see any order; a customer only their own, through
  // their account or linked customer record (never an unverified phone).
  socket.on('join-order', async (orderId) => {
    if (!orderId || !mongoose.isValidObjectId(orderId)) return;

    if (!isStaff) {
      try {
        const order = await Order.findById(orderId).select('customer customerId').lean();
        if (!order) return deny(`order-${orderId}`, 'Order not found');

        // Same rule as the REST endpoints (see utils/customerIdentity).
        if (!customerCanAccessOrder({ id: userId, customerId }, order)) {
          return deny(`order-${orderId}`, 'Not authorized to follow this order');
        }
      } catch (err) {
        logger.error(`join-order check failed for ${orderId}: ${err.message}`);
        return deny(`order-${orderId}`, 'Could not verify access');
      }
    }

    socket.join(`order-${orderId}`);
    logger.info(`${userName} joined order room: ${orderId}`);
  });

  // Leave order room
  socket.on('leave-order', (orderId) => {
    if (!orderId) return;
    socket.leave(`order-${orderId}`);
    logger.info(`${userName} left order room: ${orderId}`);
  });

  // Join chat room — staff handle any thread; a customer only their own.
  socket.on('join-chat', async (threadId) => {
    if (!threadId || !mongoose.isValidObjectId(threadId)) return;

    if (!isStaff) {
      try {
        const thread = await ChatThread.findById(threadId).select('customerId').lean();
        if (!thread) return deny(`chat-${threadId}`, 'Conversation not found');

        if (!customerId || thread.customerId.toString() !== customerId) {
          return deny(`chat-${threadId}`, 'Not authorized to view this conversation');
        }
      } catch (err) {
        logger.error(`join-chat check failed for ${threadId}: ${err.message}`);
        return deny(`chat-${threadId}`, 'Could not verify access');
      }
    }

    socket.join(`chat-${threadId}`);
    logger.info(`${userName} joined chat room: ${threadId}`);
  });

  // Leave chat room
  socket.on('leave-chat', (threadId) => {
    if (!threadId) return;
    socket.leave(`chat-${threadId}`);
    logger.info(`${userName} left chat room: ${threadId}`);
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    logger.info(`⚠️ User disconnected: ${userName} (${socket.id}) - Reason: ${reason}`);
  });

  // Handle connection errors
  socket.on('error', (error) => {
    logger.error(`Socket error for ${userName} (${socket.id}):`, error);
  });
});

// Make io accessible to req object
app.set('io', io);

// Start shift scheduler for auto-logout
startShiftScheduler(io);

// ─── Graceful shutdown ───────────────────────────────────────────────────────
// PM2 sends SIGINT on restart. Releasing the job leases here means the next
// process picks the work up immediately instead of idling until the TTL lapses.
const JOB_LOCKS = ['shiftScheduler', 'paystackRecovery', 'backfillWalkIn'];
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — releasing job locks and shutting down`);

  await Promise.allSettled(JOB_LOCKS.map((name) => releaseJobLock(name)));

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Don't hang forever if a connection refuses to drain
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  logger.error(`Unhandled Rejection: ${err.message}`);
  server.close(() => process.exit(1));
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

// ─── Pending transaction recovery & cleanup ──────────────────────────────────
//
// Called on startup and every 15 minutes while the server runs.
//
// Two buckets:
//   1. Recent (< 30 min old): restart the background verify/credit loop in case
//      the server restarted mid-flight.
//   2. Old (30 min – 24 h old): do a single Paystack check; if the payment
//      still isn't confirmed, mark the transaction as failed so it doesn't sit
//      in "pending" forever.  Transactions this old are almost certainly
//      abandoned (user closed the Paystack popup without paying).
async function recoverPendingPaystackTransactions(io) {
  try {
    // One process only. Crediting is already idempotent (webhookProcessed plus
    // the unique paystackReference index), so duplicates were never a money
    // risk here — but N workers each hammering Paystack's verify API for every
    // pending transaction every 15 minutes is a good way to get rate-limited.
    if (!(await acquireJobLock('paystackRecovery', 10 * 60 * 1000))) return;

    const now      = new Date();
    const cutoff24 = new Date(now - 24 * 60 * 60 * 1000); // 24 h ago
    const cutoff30 = new Date(now -      30 * 60 * 1000);  // 30 min ago

    const pending = await PaystackTransaction.find({
      status: 'pending',
      webhookProcessed: false,
      createdAt: { $gte: cutoff24 },
    }).select('_id reference amount createdAt').lean();

    if (pending.length === 0) {
      logger.info('[pendingCleanup] No pending Paystack transactions');
      return;
    }

    logger.info(`[pendingCleanup] ${pending.length} pending transaction(s) found`);

    for (const tx of pending) {
      const age = now - new Date(tx.createdAt);

      if (age < 30 * 60 * 1000) {
        // Recent: resume background retry loop (handles server-restart interruption)
        logger.info(`[pendingCleanup] Resuming bgVerify for ${tx.reference} (age ${Math.round(age / 1000)}s)`);
        backgroundVerifyAndCredit(tx._id, io).catch((err) =>
          logger.error(`[pendingCleanup] Recovery error for ${tx._id}: ${err.message}`)
        );
      } else {
        // Old (>30 min): quick single Paystack check then fail if still unconfirmed
        logger.info(`[pendingCleanup] Checking stale transaction ${tx.reference} (age ${Math.round(age / 60000)} min)`);
        (async () => {
          try {
            const res = await paystackRequest('GET', `/transaction/verify/${tx.reference}`, null);
            if (res.status && res.data?.status === 'success') {
              const fullTx = await PaystackTransaction.findById(tx._id);
              if (fullTx && !fullTx.webhookProcessed) {
                await processSuccessfulPaystackPayment(fullTx, res.data, io);
                logger.info(`[pendingCleanup] Late-credited stale transaction ${tx.reference}`);
              }
            } else if (!res.status || ['failed', 'abandoned', 'reversed'].includes(res.data?.status)) {
              await PaystackTransaction.findByIdAndUpdate(tx._id, {
                status: 'failed',
                failureReason: res.data?.gateway_response || 'Payment abandoned or not confirmed',
              });
              logger.warn(`[pendingCleanup] Marked stale ${tx.reference} as failed (Paystack: ${res.data?.status})`);
              if (io) {
                io.to('payments').emit('payment:paystack-failed', {
                  transactionId: tx._id,
                  reference: tx.reference,
                  amount: tx.amount,
                  reason: 'Payment abandoned or not confirmed',
                });
              }
            }
            // status=pending/processing on a 30+ min old tx → leave for next cycle
          } catch (err) {
            logger.error(`[pendingCleanup] Error checking stale ${tx.reference}: ${err.message}`);
          }
        })();
      }
    }
  } catch (err) {
    logger.error(`[pendingCleanup] Failed: ${err.message}`);
  }
}

// Drop stale indexes left over from schema migrations
async function dropLegacyIndexes() {
  try {
    const col = mongoose.connection.collection('servicelevelconfigs');
    await col.dropIndex('level_1');
    logger.info('[migration] Dropped legacy index: servicelevelconfigs.level_1');
  } catch (e) {
    // Index doesn't exist — nothing to do
  }
}

mongoose.connection.once('open', () => {
  logger.info('MongoDB connected successfully');
  logger.info(`Server environment: ${process.env.NODE_ENV || 'development'}`);

  // Clean up stale indexes from previous schema versions
  dropLegacyIndexes();

  server.listen(PORT, () => {
    logger.info(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
    logger.info(`Worker ${process.pid} started`);

    // On boot: resume retries killed by server restart (5s delay for full init)
    setTimeout(() => recoverPendingPaystackTransactions(io), 5000);

    // On boot: normalize walk-in phones and link orders to registered accounts.
    // Locked because it rewrites phone numbers and reassigns order ownership
    // across the whole collection — concurrent copies of that are not something
    // to find out about after the fact. Short TTL: it should only run once.
    setTimeout(() => {
      withJobLock('backfillWalkIn', 5 * 60 * 1000, () => backfillWalkIn())
        .catch((err) => logger.error(`[backfillWalkIn] Failed: ${err.message}`));
    }, 8000);

    // Every 15 minutes: auto-fail abandoned transactions and catch anything missed
    setInterval(() => recoverPendingPaystackTransactions(io), 15 * 60 * 1000);
  });
});

mongoose.connection.on('error', (err) => {
  logger.error({ message: 'MongoDB connection error', error: err.message });
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

module.exports = server;
