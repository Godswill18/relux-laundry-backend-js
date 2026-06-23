const winston = require('winston');

// Colors only when running in an actual terminal (never in Docker containers)
const isTTY = !!process.stdout.isTTY;
// JSON mode: opt-in via LOG_FORMAT=json env var (useful for log aggregators)
const useJson = process.env.LOG_FORMAT === 'json';

// JSON format — machine-readable, for log aggregators
const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Plain text format — readable in Dokploy/Docker without ANSI garbage
const plainFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// Pretty format — colorized, for local terminal only
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

// Format selection:
//   LOG_FORMAT=json → JSON (for log aggregators)
//   TTY (local terminal) → colored pretty text
//   No TTY (Docker/Dokploy) → plain readable text, no ANSI codes
const selectedFormat = useJson ? jsonFormat : isTTY ? prettyFormat : plainFormat;

// In Docker/Dokploy everything goes to stdout/stderr — the container runtime
// captures it. File transports are avoided because containers are ephemeral.
const logger = winston.createLogger({
  levels: customLevels.levels,
  level: process.env.LOG_LEVEL || 'http',
  format: selectedFormat,
  transports: [
    new winston.transports.Console({
      // errors → stderr, everything else → stdout
      stderrLevels: ['error'],
    }),
  ],
});

module.exports = logger;
