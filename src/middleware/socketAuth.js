// ============================================================================
// SOCKET.IO AUTHENTICATION MIDDLEWARE - JWT Verification for WebSocket Connections
// ============================================================================

const jwt = require('jsonwebtoken');
const User = require('../models/User.js');
const logger = require('../utils/logger.js');

/**
 * Socket.io authentication middleware
 * Verifies JWT token and attaches user to socket object
 */
const socketAuth = async (socket, next) => {
  try {
    // Extract token from handshake auth or query params
    const token = socket.handshake.auth.token || socket.handshake.query.token;

    if (!token) {
      logger.warn(`Socket connection rejected: No token provided (${socket.id})`);
      return next(new Error('Authentication error: No token provided'));
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded || !decoded.id) {
      logger.warn(`Socket connection rejected: Invalid token structure (${socket.id})`);
      return next(new Error('Authentication error: Invalid token'));
    }

    // Get user from database
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      logger.warn(`Socket connection rejected: User not found (${socket.id}, userId: ${decoded.id})`);
      return next(new Error('Authentication error: User not found'));
    }

    // Attach user to socket object
    socket.user = user;
    socket.userId = user._id.toString();
    socket.customerId = user.customerId ? user.customerId.toString() : null;

    logger.info(`Socket authenticated: ${user.name} (${user.email}) - Socket ID: ${socket.id}`);

    next();
  } catch (error) {
    logger.error(`Socket authentication error (${socket.id}):`, error.message);

    if (error.name === 'JsonWebTokenError') {
      return next(new Error('Authentication error: Invalid token'));
    }

    if (error.name === 'TokenExpiredError') {
      return next(new Error('Authentication error: Token expired'));
    }

    return next(new Error('Authentication error: ' + error.message));
  }
};

module.exports = socketAuth;
