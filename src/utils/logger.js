const winston = require('winston');

const isProd = process.env.NODE_ENV === 'production';

// JSON format for production (machine-readable, works with Dokploy/Docker log drivers)
const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Pretty format for development
const prettyFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// Custom levels that add 'http' between 'info' and 'verbose' so Morgan
// access logs are captured and don't silently fall below the threshold.
const customLevels = {
  levels: { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 },
  colors: { error: 'red', warn: 'yellow', info: 'green', http: 'magenta', verbose: 'cyan', debug: 'blue', silly: 'grey' },
};
winston.addColors(customLevels.colors);

// In Docker/Dokploy everything goes to stdout/stderr — the container runtime
// captures it. File transports are avoided in production because containers
// are ephemeral and log files would be lost on restart.
const logger = winston.createLogger({
  levels: customLevels.levels,
  level: process.env.LOG_LEVEL || 'http',
  format: isProd ? jsonFormat : prettyFormat,
  transports: [
    new winston.transports.Console({
      // errors → stderr, everything else → stdout
      stderrLevels: ['error'],
    }),
  ],
});

module.exports = logger;
