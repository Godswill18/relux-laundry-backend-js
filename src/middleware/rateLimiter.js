const rateLimit = require('express-rate-limit');

// General API rate limiter
exports.apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for authentication routes
exports.authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5, // 5 requests per window
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Order creation limiter
exports.orderLimiter = rateLimit({
  windowMs: 2 * 60 * 1000, // 2 minutes
  max: 10, // 10 orders per hour
  message: 'Too many orders created, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});
