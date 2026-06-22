const { randomUUID } = require('crypto');
const logger = require('../utils/logger.js');

const requestLogger = (req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('X-Request-ID', req.requestId);

  const start = Date.now();

  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = ms > 1000 ? 'warn' : 'http';
    logger[level]({
      type: 'http',
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      responseTime: ms,
      ip: req.ip || req.headers['x-forwarded-for'],
      userId: req.user?.id || null,
      userAgent: req.headers['user-agent'],
    });
  });

  next();
};

module.exports = requestLogger;
