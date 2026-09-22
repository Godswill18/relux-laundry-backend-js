const Order = require('../models/Order.js');
const normalizePhone = require('./normalizePhone.js');
const logger = require('./logger.js');

/**
 * Startup (idempotent) housekeeping: normalize walk-in order phone numbers to
 * E.164 format.
 *
 * It USED to also link walk-in orders to any portal account whose phone
 * matched. Portal phones are never verified, so on every deploy this re-attached
 * other people's walk-in orders to whoever had registered with their number.
 * Linking is now done only through customer records and verified identities —
 * see utils/customerIdentity and utils/migrations/linkWalkInCustomers.
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

    const bulkOps = [];
    let normalizedCount = 0;

    for (const order of walkInOrders) {
      const raw = order.walkInCustomer?.phone;
      const normalized = normalizedMap.get(raw) || raw;
      const update = {};

      if (normalized !== raw) {
        update['walkInCustomer.phone'] = normalized;
        normalizedCount++;
      }

      if (Object.keys(update).length > 0) {
        bulkOps.push({ updateOne: { filter: { _id: order._id }, update: { $set: update } } });
      }
    }

    if (bulkOps.length > 0) await Order.bulkWrite(bulkOps);

    logger.info(
      `[backfillWalkIn] Done — ${walkInOrders.length} orders scanned, ` +
      `${normalizedCount} phones normalized`
    );
  } catch (err) {
    logger.error(`[backfillWalkIn] Failed: ${err.message}`);
  }
}

module.exports = backfillWalkIn;
