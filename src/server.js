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
const PaystackTransaction = require('./models/PaystackTransaction.js');
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

  // Join payments room for admin real-time payment updates
  socket.on('join-payments', () => {
    socket.join('payments');
    logger.info(`${userName} joined payments room`);
  });

  socket.on('leave-payments', () => {
    socket.leave('payments');
    logger.info(`${userName} left payments room`);
  });

  // Join order room for real-time updates
  socket.on('join-order', (orderId) => {
    if (!orderId) return;
    socket.join(`order-${orderId}`);
    logger.info(`${userName} joined order room: ${orderId}`);
  });

  // Leave order room
  socket.on('leave-order', (orderId) => {
    if (!orderId) return;
    socket.leave(`order-${orderId}`);
    logger.info(`${userName} left order room: ${orderId}`);
  });

  // Join chat room for real-time messaging
  socket.on('join-chat', (threadId) => {
    if (!threadId) return;
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

mongoose.connection.once('open', () => {
  console.log('✅ MongoDB Connected Successfully');
  console.log(`🚀 Server Environment: ${process.env.NODE_ENV || 'development'}`);

  server.listen(PORT, () => {
    logger.info(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
    logger.info(`Worker ${process.pid} started`);
    console.log(`🎉 Server running successfully on port ${PORT}`);
    console.log(`📍 Server URL: http://localhost:${PORT}`);
    console.log(`🔗 Health check: GET /`);
    console.log('─'.repeat(50));

    // On boot: resume retries killed by server restart (5s delay for full init)
    setTimeout(() => recoverPendingPaystackTransactions(io), 5000);

    // Every 15 minutes: auto-fail abandoned transactions and catch anything missed
    setInterval(() => recoverPendingPaystackTransactions(io), 15 * 60 * 1000);
  });
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

module.exports = server;
