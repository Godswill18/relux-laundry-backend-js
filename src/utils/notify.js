// ============================================================================
// NOTIFY UTILITY — persist in-app notification + emit socket event + web push
// ============================================================================

const Notification = require('../models/Notification.js');
const logger = require('./logger.js');
const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription.js');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:support@reluxlaundry.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

function resolveUrl(type, metadata = {}) {
  const orderId = metadata.orderId;
  switch (type) {
    case 'order_created':
    case 'order_status_updated':
    case 'order_cancelled':
    case 'order_ready_for_delivery':
    case 'order_needs_pickup':
      return orderId ? `/orders/${orderId}` : '/orders';
    case 'wallet_credited':
      return '/wallet';
    case 'referral_rewarded':
      return '/referrals';
    case 'points_earned':
    case 'points_converted':
      return '/loyalty';
    case 'site_announcement':
      return '/dashboard';
    default:
      return '/dashboard';
  }
}

async function sendPushToUser({ userId, customerId, title, body, type, metadata }) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const query = [];
  if (userId)     query.push({ userId });
  if (customerId) query.push({ customerId });
  if (!query.length) return;

  const subs = await PushSubscription.find({ $or: query }).lean();
  if (!subs.length) return;

  const payload = JSON.stringify({
    title: title || 'Relux',
    body:  body  || '',
    icon:  '/favicon.webp',
    badge: '/favicon.webp',
    data:  { type, metadata, url: resolveUrl(type, metadata) },
  });

  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload)
    )
  );

  const expiredEndpoints = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const status = r.reason?.statusCode;
      if (status === 410 || status === 404) expiredEndpoints.push(subs[i].endpoint);
    }
  });
  if (expiredEndpoints.length) {
    PushSubscription.deleteMany({ endpoint: { $in: expiredEndpoints } }).catch(() => {});
  }
}

async function sendPushToRoom(room, { title, body, type, metadata }) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  // All staff/admin/manager subscriptions have userId set; customers only have customerId
  const subs = await PushSubscription.find({ userId: { $exists: true, $ne: null } }).lean();
  if (!subs.length) return;

  const payload = JSON.stringify({
    title: title || 'Relux',
    body:  body  || '',
    icon:  '/favicon.webp',
    badge: '/favicon.webp',
    data:  { type, metadata },
  });

  const results = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload)
    )
  );

  const expiredEndpoints = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const status = r.reason?.statusCode;
      if (status === 410 || status === 404) expiredEndpoints.push(subs[i].endpoint);
    }
  });
  if (expiredEndpoints.length) {
    PushSubscription.deleteMany({ endpoint: { $in: expiredEndpoints } }).catch(() => {});
  }
}

/**
 * Create a persistent in-app notification and emit a socket event.
 *
 * @param {object} io          - Socket.io server instance (may be null/undefined)
 * @param {object} opts
 * @param {string}  opts.type        - Notification.type enum value
 * @param {string}  opts.title       - Short title
 * @param {string}  opts.body        - Longer description
 * @param {string}  [opts.userId]    - Staff/admin User._id string (for staff/admin notifs)
 * @param {string}  [opts.customerId]- Customer._id string (for customer notifs)
 * @param {object}  [opts.metadata]  - Extra payload attached to the notification
 * @param {string}  [opts.room]      - Socket room to broadcast to (e.g. 'admin')
 *                                     Defaults to user-{userId} or user-{customerId}
 * @param {string}  [opts.event]     - Socket event name. Defaults to 'notification:new'
 */
async function notify(io, opts) {
  const {
    type,
    title,
    body,
    userId,
    customerId,
    metadata = {},
    room,
    event = 'notification:new',
  } = opts;

  // 1. Persist
  let saved;
  try {
    saved = await Notification.create({
      type,
      title,
      body,
      userId:     userId     || undefined,
      customerId: customerId || undefined,
      channel: 'in_app',
      metadata,
    });
  } catch (err) {
    logger.error(`[notify] DB save failed for type=${type}: ${err.message}`);
    saved = { _id: null, type, title, body, metadata, createdAt: new Date() };
  }

  // 2. Emit via Socket.io
  if (io) {
    const payload = {
      _id:        saved._id,
      type,
      title,
      body,
      metadata,
      createdAt: saved.createdAt || new Date(),
    };

    const targetRoom = room
      || (userId     ? `user-${userId}`     : null)
      || (customerId ? `user-${customerId}` : null);

    if (targetRoom) {
      io.to(targetRoom).emit(event, payload);
    }
  }

  // 3. Web Push (fire-and-forget — non-blocking)
  if (userId || customerId) {
    sendPushToUser({ userId, customerId, title, body, type, metadata }).catch(() => {});
  } else if (room) {
    sendPushToRoom(room, { title, body, type, metadata }).catch(() => {});
  }

  return saved;
}

module.exports = notify;
