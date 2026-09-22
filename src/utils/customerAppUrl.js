const logger = require('./logger.js');

// Base URL of the customer app, for links in emails.
//
// CLIENT_URL is the source of truth. It is only overridden when it would
// produce a broken link for a real customer — unset, or still pointing at a
// local dev server while running in production. The fallback is the customer
// origin the API's CORS allowlist admits (config/allowedOrigins.js).
const PRODUCTION_FALLBACK = 'https://relux.ng';
let warned = false;

function customerAppUrl() {
  const configured = (process.env.CLIENT_URL || '').trim().replace(/\/+$/, '');
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(configured);

  if (process.env.NODE_ENV === 'production' && (!configured || isLocal)) {
    if (!warned) {
      logger.warn(`[customerAppUrl] CLIENT_URL is ${configured ? 'a local address' : 'unset'} in production — email links use ${PRODUCTION_FALLBACK}. Set CLIENT_URL to the customer app's address.`);
      warned = true;
    }
    return PRODUCTION_FALLBACK;
  }
  return configured || PRODUCTION_FALLBACK;
}

// Link to the verification page with the address pre-filled. The code itself
// is never put in the link: URLs end up in browser history, logs and referrers.
function verifyEmailLink(email) {
  return `${customerAppUrl()}/auth/verify-email?email=${encodeURIComponent(email)}`;
}

module.exports = { customerAppUrl, verifyEmailLink };
