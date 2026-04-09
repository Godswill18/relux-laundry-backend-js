// ============================================================================
// NOTIFY UTILITY — persist in-app notification + emit socket event
// ============================================================================

const Notification = require('../models/Notification.js');
const logger = require('./logger.js');

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

  return saved;
}

module.exports = notify;
