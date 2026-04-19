const Order = require('../models/Order.js');
const User = require('../models/User.js');
const normalizePhone = require('./normalizePhone.js');
const logger = require('./logger.js');

/**
 * One-time (idempotent) backfill:
 * 1. Normalize all walk-in order phone numbers to E.164 format.
 * 2. Link walk-in orders to registered user accounts where phone matches.
 *
 * Safe to run on every startup — already-normalized phones and already-linked
 * orders are detected and skipped, so re-runs are no-ops.
 */
async function backfillWalkIn() {
  try {
    const walkInOrders = await Order.find({
      orderSource: 'offline',
      'walkInCustomer.phone': { $exists: true, $ne: null, $ne: '' },
    }).lean();

    if (walkInOrders.length === 0) {
      logger.info('[backfillWalkIn] No walk-in orders to process');
      return;
    }

    // Build phone → normalized map and lookup registered users in one query
    const rawPhones = [...new Set(walkInOrders.map((o) => o.walkInCustomer?.phone).filter(Boolean))];
    const normalizedMap = new Map();
    for (const raw of rawPhones) {
      normalizedMap.set(raw, normalizePhone(raw) || raw);
    }

    const uniqueNormalized = [...new Set(normalizedMap.values())];
    const matchedUsers = await User.find({ phone: { $in: uniqueNormalized } })
      .select('_id customerId phone').lean();
    const userMap = new Map(matchedUsers.map((u) => [u.phone, u]));

    const bulkOps = [];
    let normalizedCount = 0;
    let linkedCount = 0;

    for (const order of walkInOrders) {
      const raw = order.walkInCustomer?.phone;
      const normalized = normalizedMap.get(raw) || raw;
      const matchedUser = userMap.get(normalized);
      const update = {};

      if (normalized !== raw) {
        update['walkInCustomer.phone'] = normalized;
        normalizedCount++;
      }
      if (matchedUser && order.customer?.toString() !== matchedUser._id.toString()) {
        update.customer = matchedUser._id;
        update.customerId = matchedUser.customerId;
        linkedCount++;
      }

      if (Object.keys(update).length > 0) {
        bulkOps.push({ updateOne: { filter: { _id: order._id }, update: { $set: update } } });
      }
    }

    if (bulkOps.length > 0) await Order.bulkWrite(bulkOps);

    logger.info(
      `[backfillWalkIn] Done — ${walkInOrders.length} orders scanned, ` +
      `${normalizedCount} phones normalized, ${linkedCount} orders linked to accounts`
    );
  } catch (err) {
    logger.error(`[backfillWalkIn] Failed: ${err.message}`);
  }
}

module.exports = backfillWalkIn;
