require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const app = require('./app.js');
const connectDB = require('./config/database.js');
const logger = require('./utils/logger.js');
const mongoose = require('mongoose');

// Connect to database
connectDB();

const PORT = process.env.PORT || 5000;

// Create HTTP server
const server = http.createServer(app);

// Socket.io setup for real-time updates
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
  },
});

// Socket.io connection
io.on('connection', (socket) => {
  logger.info(`New client connected: ${socket.id}`);

  // Join order room for real-time updates
  socket.on('join-order', (orderId) => {
    socket.join(`order-${orderId}`);
    logger.info(`Client ${socket.id} joined order room: ${orderId}`);
  });

  // Leave order room
  socket.on('leave-order', (orderId) => {
    socket.leave(`order-${orderId}`);
    logger.info(`Client ${socket.id} left order room: ${orderId}`);
  });

  // Join user room
  socket.on('join-user', (userId) => {
    socket.join(`user-${userId}`);
    logger.info(`Client ${socket.id} joined user room: ${userId}`);
  });

  // Join chat room for real-time messaging
  socket.on('join-chat', (threadId) => {
    socket.join(`chat-${threadId}`);
    logger.info(`Client ${socket.id} joined chat room: ${threadId}`);
  });

  // Leave chat room
  socket.on('leave-chat', (threadId) => {
    socket.leave(`chat-${threadId}`);
    logger.info(`Client ${socket.id} left chat room: ${threadId}`);
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Make io accessible to req object
app.set('io', io);


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
  });
});

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected');
});

module.exports = server;
