const rateLimit = require('express-rate-limit');

// Extract the real client IP, handling proxies and load balancers.
// Uses X-Forwarded-For first (set by proxies), falls back to req.ip.
const getClientIP = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For can be a comma-separated chain: "clientIP, proxy1, proxy2"
    // The first entry is always the original client.
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.ip || 'unknown';
};

// Build a per-IP key. For authenticated requests, fall back to userId
// when multiple users share the same NAT/proxy IP.
const ipKey = (req) => {
  const ip = getClientIP(req);
  return `rl:${ip}`;
};

const ipOrUserKey = (req) => {
  const ip = getClientIP(req);
  // Authenticated users get isolated limits by userId, preventing one
  // shared-IP user from consuming another user's quota.
  if (req.user && req.user.id) {
    return `rl:user:${req.user.id}`;
  }
  return `rl:${ip}`;
};

const tooManyRequestsMessage = (_req, res) => {
  res.status(429).json({
    success: false,
    message: 'Too many requests. Please try again later.',
    retryAfter: res.getHeader('Retry-After'),
  });
};

// ── General API limiter ────────────────────────────────────────────────────
// Applied per-IP on all /api routes. High ceiling — just a safety net.
// Ceiling is deliberately generous: this runs before `protect`, so it is keyed by
// IP and every device behind the shop's NAT shares one bucket. It is a runaway-
// script backstop, not a per-user quota — see moneyLimiter for that.
exports.apiLimiter = rateLimit({
  windowMs: 3 * 60 * 1000,           // 3-minute window
  max: 1500,                          // 1500 req per IP per window
  keyGenerator: ipKey,
  handler: tooManyRequestsMessage,
  standardHeaders: true,              // RateLimit-* headers (RFC 6585)
  legacyHeaders: false,               // Disable X-RateLimit-* headers
  skipSuccessfulRequests: false,
});

// ── Auth limiter ───────────────────────────────────────────────────────────
// Tight limit on login / register / OTP to block brute force.
exports.authLimiter = rateLimit({
  windowMs: 3 * 60 * 1000,          // 3-minute window
  max: 10,                            // 10 attempts per IP per window
  keyGenerator: ipKey,
  handler: tooManyRequestsMessage,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,       // Successful logins don't count against the limit
});

// ── Sensitive-endpoint limiter ─────────────────────────────────────────────
// Wallet and payment routes. Tighter than the general limiter because these are
// the endpoints where scripted abuse actually costs money.
//
// Keying: ipOrUserKey prefers req.user, but this is mounted at the app level
// ahead of each route's own `protect`, so in practice it falls back to the IP.
// Keep the ceiling comfortably above what a shop full of staff generates.
exports.moneyLimiter = rateLimit({
  windowMs: 3 * 60 * 1000,            // 3-minute window
  max: 120,                           // 120 money-route calls per IP per window
  keyGenerator: ipOrUserKey,
  handler: tooManyRequestsMessage,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Order creation limiter ─────────────────────────────────────────────────
// Per authenticated user (or IP if unauthenticated) to prevent order spam.
exports.orderLimiter = rateLimit({
  windowMs: 2 * 60 * 1000,           // 2-minute window
  max: 10,                            // 10 order creations per user per window
  keyGenerator: ipOrUserKey,
  handler: tooManyRequestsMessage,
  standardHeaders: true,
  legacyHeaders: false,
});
