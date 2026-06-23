const { randomUUID } = require('crypto');
const logger = require('../utils/logger.js');

const requestLogger = (req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('X-Request-ID', req.requestId);

  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = ms > 1000 ? 'warn' : 'http';
    logger[level](
      `${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`,
      {
        requestId: req.requestId,
        userId: req.user?.id || null,
        ip: req.ip || req.headers['x-forwarded-for'],
      }
    );
  });

  next();
};

module.exports = requestLogger;
