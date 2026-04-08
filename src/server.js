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
const { backgroundVerifyAndCredit } = require('./controllers/paymentController.js');

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

// ─── Startup recovery: resume background retries for any pending Paystack
// transactions that were interrupted by a server restart.
async function recoverPendingPaystackTransactions(io) {
  try {
    // Only recover transactions created in the last 24 hours to avoid
    // wasting time on very old failed/abandoned transactions.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pending = await PaystackTransaction.find({
      status: 'pending',
      webhookProcessed: false,
      createdAt: { $gte: cutoff },
    }).select('_id reference createdAt').lean();

    if (pending.length === 0) {
      logger.info('[startup] No pending Paystack transactions to recover');
      return;
    }

    logger.info(`[startup] Recovering ${pending.length} pending Paystack transaction(s)…`);
    for (const tx of pending) {
      logger.info(`[startup] Resuming background verify for ${tx.reference} (created ${tx.createdAt})`);
      backgroundVerifyAndCredit(tx._id, io).catch((err) =>
        logger.error(`[startup] Recovery error for ${tx._id}: ${err.message}`)
      );
    }
  } catch (err) {
    logger.error(`[startup] Failed to recover pending transactions: ${err.message}`);
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

    // Resume any background retries that were killed by the last server restart.
    // Runs 5 seconds after boot to give the server time to fully initialize.
    setTimeout(() => recoverPendingPaystackTransactions(io), 5000);
  });
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

module.exports = server;
