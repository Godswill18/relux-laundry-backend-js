const logger = require('../utils/logger.js');
const ERROR_CODES = require('../utils/errorCodes.js');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  let errorCode = err.errorCode || 'SERVER_ERROR';

  // Log error
  logger.error(err);

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Resource not found';
    error = { message, statusCode: 404 };
    errorCode = ERROR_CODES.NOT_FOUND;
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `${field} already exists`;
    error = { message, statusCode: 400 };
    errorCode = ERROR_CODES.DUPLICATE_KEY;
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map((val) => val.message);
    error = { message, statusCode: 400 };
    errorCode = ERROR_CODES.VALIDATION_ERROR;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    const message = 'Invalid token';
    error = { message, statusCode: 401 };
    errorCode = ERROR_CODES.TOKEN_INVALID;
  }

  if (err.name === 'TokenExpiredError') {
    const message = 'Token expired';
    error = { message, statusCode: 401 };
    errorCode = ERROR_CODES.TOKEN_EXPIRED;
  }

  // Standardized error response format
  res.status(error.statusCode || 500).json({
    success: false,
    data: null,
    message: error.message || 'Server Error',
    error: {
      code: errorCode,
      message: error.message || 'Server Error',
    },
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
