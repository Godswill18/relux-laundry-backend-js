// ─── Garment tracking: readiness and collection per order line ───────────────
//
// An order's `status` is its processing workflow (confirmed → washing → ready
// → delivered/completed). paymentStatus is the money. Neither says where the
// garments are, so an order with 6 of 10 garments ready and 2 collected could
// only be shown as one status that lost the rest. This module records, per
// line, how many garments are ready and how many have been handed back, and
// derives the order-level picture from that.
//
// Model (see OrderItemSchema):  0 ≤ collectedQuantity ≤ readyQuantity ≤ quantity
//
// Orders written before tracking existed (itemTracking not set) are never
// back-filled with invented numbers. Their picture is read from their status,
// and marked as not recorded. An open legacy order starts tracking the first
// time someone marks or collects garments on it (ensureTracking).
//
// Concurrency: every change to the lines is saved conditionally on the
// fulfilmentVersion it read, inside a transaction when the deployment has
// them. Two staff releasing the last garment at the same moment: one save
// wins, the other re-reads, finds nothing left to release and is refused.

const mongoose = require('mongoose');
const Order = require('../models/Order.js');
const OrderCollection = require('../models/OrderCollection.js');
const User = require('../models/User.js');
const AppError = require('./appError.js');
const ERROR_CODES = require('./errorCodes.js');
const notify = require('./notify.js');
const logger = require('./logger.js');

// Statuses that mean every garment has been finished / handed over.
const {
  READY_STATUSES: READY_IMPLIED_STATUSES,
  COLLECTED_STATUSES: COLLECTED_IMPLIED_STATUSES,
  PRE_READY_STATUSES: CANONICAL_PRE_READY,
} = require('./orderStatus.js');
// Statuses an order is in before its garments are all ready.
const PRE_READY_STATUSES = ['draft', ...CANONICAL_PRE_READY];

const invalid = (message) => new AppError(message, 400, ERROR_CODES.VALIDATION_ERROR);

// ── Derivation ───────────────────────────────────────────────────────────────

function deriveFulfilmentStatus(total, ready, collected) {
  if (total <= 0) return 'processing';
  if (collected >= total) return 'collected';
  if (collected > 0) return 'partially_collected';
  if (ready >= total) return 'ready';
  if (ready > 0) return 'partially_ready';
  return 'processing';
}

const lineLabel = (item) => `${item.itemType || 'Item'}${item.serviceName ? ` (${item.serviceName})` : ''}`;

// Ready / collected for one line. Legacy orders are read from their status.
function lineCounts(item, order) {
  const quantity = item.quantity || 0;
  if (order.itemTracking) {
    const ready = Math.min(item.readyQuantity || 0, quantity);
    return { quantity, ready, collected: Math.min(item.collectedQuantity || 0, ready) };
  }
  const allReady = READY_IMPLIED_STATUSES.includes(order.status);
  const allCollected = COLLECTED_IMPLIED_STATUSES.includes(order.status);
  return { quantity, ready: allReady ? quantity : 0, collected: allCollected ? quantity : 0 };
}

/**
 * The garment picture for an order — the single definition every screen and
 * report uses. Works on a Mongoose document or a plain object.
 */
function summarizeFulfilment(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const lines = items.map((item) => {
    const { quantity, ready, collected } = lineCounts(item, order);
    return {
      itemId: item._id,
      itemType: item.itemType,
      serviceName: item.serviceName,
      quantity,
      ready,
      collected,
      processing: quantity - ready,
      awaitingCollection: ready - collected,
      outstanding: quantity - collected,
      status: deriveFulfilmentStatus(quantity, ready, collected),
    };
  });
  const sum = (key) => lines.reduce((s, l) => s + l[key], 0);
  const total = sum('quantity');
  const ready = sum('ready');
  const collected = sum('collected');
  return {
    // false → counts are inferred from the order status (placed before
    // garment tracking); no per-garment history or collection records exist.
    recorded: !!order?.itemTracking,
    totalGarments: total,
    processingGarments: total - ready,
    readyGarments: ready,
    awaitingCollection: ready - collected,
    collectedGarments: collected,
    outstandingGarments: total - collected,
    status: order?.status === 'cancelled' ? 'cancelled' : deriveFulfilmentStatus(total, ready, collected),
    lines,
  };
}

// Refresh the denormalised order-level counters from the lines.
function applyCounters(order) {
  const items = order.items || [];
  order.totalGarments = items.reduce((s, i) => s + (i.quantity || 0), 0);
  if (!order.itemTracking) return;
  order.readyGarments = items.reduce((s, i) => s + (i.readyQuantity || 0), 0);
  order.collectedGarments = items.reduce((s, i) => s + (i.collectedQuantity || 0), 0);
  order.fulfilmentStatus = deriveFulfilmentStatus(order.totalGarments, order.readyGarments, order.collectedGarments);
}

// Fields a brand-new order starts with.
function initialTrackingFields(items) {
  const totalGarments = items.reduce((s, i) => s + (i.quantity || 0), 0);
  return {
    itemTracking: true,
    totalGarments,
    readyGarments: 0,
    collectedGarments: 0,
    fulfilmentStatus: 'processing',
    fulfilmentVersion: 0,
    collectionCount: 0,
  };
}

// ── Concurrency guard ────────────────────────────────────────────────────────

// Orders saved before this field existed have no value, which counts as 0.
function versionFilter(version) {
  return version ? { fulfilmentVersion: version } : { fulfilmentVersion: { $in: [0, null] } };
}

// Make the next save of this document conditional on the version it was read
// at, and bump it. Call once per logical change (never inside a retried
// transaction callback).
function guardVersion(order) {
  const version = order.fulfilmentVersion || 0;
  order.$where = { ...(order.$where || {}), ...versionFilter(version) };
  order.fulfilmentVersion = version + 1;
}

// Save a document whose lines changed, conditional on its version. The filter
// is cleared afterwards so a later ordinary save of the same document is not
// held to a version that has moved on.
async function saveGuarded(order, options = {}) {
  guardVersion(order);
  try {
    await order.save(options);
  } catch (err) {
    if (isConcurrencyConflict(err)) throw conflictError();
    throw err;
  } finally {
    order.$where = null;
  }
}

function isConcurrencyConflict(err) {
  if (!err) return false;
  if (err.name === 'DocumentNotFoundError' || err.name === 'VersionError') return true;
  if (err.code === 112) return true; // WriteConflict
  if (err.code === 11000 && err.keyPattern && err.keyPattern.sequence) return true;
  return typeof err.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError');
}

const conflictError = () => new AppError(
  'This order was updated by someone else at the same moment. Refresh it and try again.',
  409
);

// Run fn inside a transaction when the deployment supports one (Atlas / any
// replica set); otherwise without, relying on the version guard.
async function withOptionalTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } catch (err) {
    const unsupported = err.code === 20 || /replica set|Transaction numbers/i.test(err.message || '');
    if (!unsupported) throw err;
    logger.warn('[orderFulfilment] Transactions unavailable — running without a session');
    return fn(null);
  } finally {
    session.endSession();
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

function pushEvent(order, event) {
  if (!Array.isArray(order.fulfilmentHistory)) order.fulfilmentHistory = [];
  order.fulfilmentHistory.push({ at: new Date(), ...event });
}

const eventItems = (entries) => entries.map(({ item, quantity }) => ({
  itemId: item._id,
  itemType: item.itemType,
  serviceName: item.serviceName,
  quantity,
}));

// ── Legacy orders ────────────────────────────────────────────────────────────

/**
 * Start recording garments on an order placed before tracking existed.
 * Returns true if tracking was started now.
 *
 * Only the facts the status already asserts are recorded: an order at 'ready'
 * has every garment ready; anything earlier has none. A delivered/completed
 * legacy order is refused — its handover happened without a record, and one
 * is not invented after the fact.
 */
function ensureTracking(order, actor, source = 'items') {
  if (order.itemTracking) return false;
  if (!Array.isArray(order.items) || order.items.length === 0) {
    throw invalid('This order has no items to track');
  }
  if (order.status === 'cancelled') throw invalid('This order is cancelled');
  if (COLLECTED_IMPLIED_STATUSES.includes(order.status)) {
    throw new AppError(
      `This order was ${order.status} before garment-level tracking was introduced, so there is nothing left to collect.`,
      409
    );
  }
  const allReady = READY_IMPLIED_STATUSES.includes(order.status);
  for (const item of order.items) {
    item.readyQuantity = allReady ? item.quantity : 0;
    item.collectedQuantity = 0;
  }
  order.itemTracking = true;
  if (order.collectionCount == null) order.collectionCount = 0;
  // The customer was already told this order is ready when its status moved
  // there — don't announce it again now that the garments are recorded.
  if (allReady && !order.readyNotifications?.fullAt) order.set('readyNotifications.fullAt', new Date());
  pushEvent(order, {
    type: 'tracking_started',
    source,
    by: actor?._id || actor?.id,
    byRole: actor?.role,
    quantity: allReady ? order.items.reduce((s, i) => s + (i.quantity || 0), 0) : 0,
    notes: allReady
      ? `Order was already "${order.status}" — every garment recorded as ready`
      : 'Garment-level tracking started',
  });
  return true;
}

// ── Mutations (in memory; the caller saves) ──────────────────────────────────

// [{ itemId, quantity }] → [{ item, quantity }], or a 400 naming the line.
function resolveEntries(order, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw invalid('Choose at least one item');
  const seen = new Set();
  const resolved = [];
  for (const entry of entries) {
    const itemId = entry && entry.itemId;
    const item = itemId && mongoose.isValidObjectId(itemId) ? order.items.id(itemId) : null;
    if (!item) throw invalid('One of the selected items is not on this order');
    if (seen.has(String(item._id))) throw invalid(`${lineLabel(item)} is listed twice`);
    seen.add(String(item._id));
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw invalid(`${lineLabel(item)}: quantity must be a whole number`);
    }
    if (quantity === 0) continue; // an untouched row in the form
    resolved.push({ item, quantity });
  }
  if (resolved.length === 0) throw invalid('Enter a quantity for at least one item');
  return resolved;
}

/**
 * Mark garments ready (or, with undo, move them back to processing — a
 * correction for a mis-tap; never below what has already been collected).
 */
function applyReady(order, entries, actor, { undo = false, source = 'items', notes } = {}) {
  const resolved = resolveEntries(order, entries);
  for (const { item, quantity } of resolved) {
    const ready = item.readyQuantity || 0;
    const collected = item.collectedQuantity || 0;
    if (undo) {
      if (ready - quantity < collected) {
        const movable = ready - collected;
        throw invalid(movable > 0
          ? `${lineLabel(item)}: only ${movable} garment(s) can be moved back — ${collected} have already been collected`
          : `${lineLabel(item)}: there are no uncollected ready garments to move back`);
      }
      item.readyQuantity = ready - quantity;
    } else {
      const remaining = item.quantity - ready;
      if (quantity > remaining) {
        throw invalid(remaining > 0
          ? `${lineLabel(item)}: only ${remaining} garment(s) are still being processed — you entered ${quantity}`
          : `${lineLabel(item)}: every garment on this line is already ready`);
      }
      item.readyQuantity = ready + quantity;
    }
  }
  pushEvent(order, {
    type: undo ? 'ready_undone' : 'ready',
    source,
    items: eventItems(resolved),
    quantity: resolved.reduce((s, e) => s + e.quantity, 0),
    by: actor?._id || actor?.id,
    byRole: actor?.role,
    notes,
  });
  return resolved;
}

// Everything not yet ready → ready. Returns the number of garments moved.
function markAllReady(order, actor, { source = 'items', notes } = {}) {
  const entries = order.items
    .filter((i) => (i.readyQuantity || 0) < i.quantity)
    .map((i) => ({ itemId: i._id, quantity: i.quantity - (i.readyQuantity || 0) }));
  if (entries.length === 0) return 0;
  return applyReady(order, entries, actor, { source, notes }).reduce((s, e) => s + e.quantity, 0);
}

/**
 * Record garments as handed over. Returns the collection document to insert
 * (not yet saved) — the caller writes it in the same transaction as the order.
 */
function applyCollect(order, entries, actor, meta = {}) {
  const resolved = resolveEntries(order, entries);
  for (const { item, quantity } of resolved) {
    const ready = item.readyQuantity || 0;
    const collected = item.collectedQuantity || 0;
    const available = ready - collected;
    if (quantity > available) {
      if (available <= 0) {
        throw invalid(collected >= item.quantity
          ? `${lineLabel(item)}: every garment on this line has already been collected`
          : `${lineLabel(item)}: no garments on this line are ready to collect yet`);
      }
      throw invalid(`${lineLabel(item)}: only ${available} garment(s) are ready to collect — you entered ${quantity}`);
    }
    item.collectedQuantity = collected + quantity;
  }

  order.collectionCount = (order.collectionCount || 0) + 1;
  const totalQuantity = resolved.reduce((s, e) => s + e.quantity, 0);
  const collection = {
    _id: new mongoose.Types.ObjectId(),
    orderId: order._id,
    orderNumber: order.orderNumber,
    customerId: order.customerId || undefined,
    sequence: order.collectionCount,
    items: resolved.map(({ item, quantity }) => ({
      orderItemId: item._id,
      itemType: item.itemType,
      serviceName: item.serviceName,
      quantity,
    })),
    totalQuantity,
    method: meta.method || 'counter',
    releasedBy: actor?._id || actor?.id,
    releasedByRole: actor?.role,
    collectedBy: meta.collectedBy,
    verification: meta.verification || 'none',
    paymentStatusAtCollection: order.paymentStatus,
    notes: meta.notes,
    idempotencyKey: meta.idempotencyKey,
  };

  pushEvent(order, {
    type: 'collected',
    source: meta.source || 'items',
    items: eventItems(resolved),
    quantity: totalQuantity,
    collectionId: collection._id,
    by: actor?._id || actor?.id,
    byRole: actor?.role,
    notes: meta.notes,
  });
  return collection;
}

// Money settled enough for the order to close automatically. Collection itself
// never depends on payment — this only decides whether the workflow status
// may move to 'completed', matching the counter rule that an unpaid order is
// not marked completed.
const paymentSettled = (order) => order.paymentStatus === 'paid'
  || (order.pricing?.total ?? order.total ?? 0) <= 0;

/**
 * After garments move: refresh counters and move the workflow status where the
 * garments now clearly put it. Returns what changed, for notifications.
 */
function settleOrderStatus(order, actor, before) {
  applyCounters(order);
  const total = order.totalGarments || 0;
  const ready = order.readyGarments || 0;
  const collected = order.collectedGarments || 0;
  const changes = {
    becamePartiallyReady: before.ready === 0 && ready > 0 && ready < total,
    becameFullyReady: before.ready < total && total > 0 && ready >= total,
    becameFullyCollected: before.collected < total && total > 0 && collected >= total,
    statusChangedTo: null,
    previousStatus: order.status,
    awaitingPayment: false,
  };

  const setStatus = (status, notes) => {
    order.status = status;
    order.lastUpdatedById = actor?._id || actor?.id;
    // Neither 'ready' nor 'completed' is a timed stage
    order.stageDeadlineAt = null;
    order.stageDurationMinutes = null;
    order.statusHistory.push({
      status,
      updatedBy: actor?._id || actor?.id,
      actorRole: actor?.role,
      notes,
    });
    changes.statusChangedTo = status;
  };

  if (collected >= total && total > 0) {
    if (!['completed', 'cancelled'].includes(order.status)) {
      if (paymentSettled(order)) setStatus('completed', 'All garments collected');
      else changes.awaitingPayment = true;
    }
  } else if (ready >= total && total > 0 && PRE_READY_STATUSES.includes(order.status)) {
    setStatus('ready', 'All garments marked ready');
  }
  return changes;
}

const countersOf = (order) => {
  const items = order.items || [];
  return {
    ready: items.reduce((s, i) => s + (order.itemTracking ? (i.readyQuantity || 0) : 0), 0),
    collected: items.reduce((s, i) => s + (order.itemTracking ? (i.collectedQuantity || 0) : 0), 0),
  };
};

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * Apply a garment change to an order safely. `change(order)` mutates the
 * freshly-read document and may return a collection document to insert.
 * Retries on a concurrent update: each attempt re-reads, so validation always
 * runs against the latest counts.
 */
async function runFulfilmentChange(orderId, actor, change, { maxAttempts = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let insertedWithoutSession = null;
    try {
      return await withOptionalTransaction(async (session) => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new AppError('Order not found', 404);
        const before = countersOf(order);
        const outcome = (await change(order)) || {};
        const changes = settleOrderStatus(order, actor, before);

        const version = order.fulfilmentVersion || 0;
        order.$where = versionFilter(version);
        order.fulfilmentVersion = version + 1;

        let collection = null;
        if (outcome.collection) {
          [collection] = await OrderCollection.create([outcome.collection], { session });
          if (!session) insertedWithoutSession = collection._id;
        }
        await order.save({ session });
        order.$where = null;
        return { order, collection, changes, outcome };
      });
    } catch (err) {
      // Without a transaction, undo the collection record the lost race wrote.
      if (insertedWithoutSession) {
        await OrderCollection.deleteOne({ _id: insertedWithoutSession })
          .catch((e) => logger.error(`[orderFulfilment] Could not remove orphaned collection ${insertedWithoutSession}: ${e.message}`));
      }
      if (!isConcurrencyConflict(err)) throw err;
      if (attempt >= maxAttempts) throw conflictError();
      logger.warn(`[orderFulfilment] Concurrent update on order ${orderId}, retry ${attempt}/${maxAttempts}`);
    }
  }
}

/**
 * Keep the garments consistent with a whole-order status change made through
 * the existing status controls (status dropdown, delivery scan):
 *   ready / out-for-delivery → every garment ready
 *   delivered / completed    → every garment ready and handed over, recorded
 *                              as one collection (method delivery / status_update)
 * Mutates the loaded document; returns a collection document to insert, or null.
 * Legacy orders are left alone — their picture is already read from status.
 */
function syncFulfilmentForStatus(order, status, actor, { source = 'status_update' } = {}) {
  if (!order.itemTracking || !Array.isArray(order.items) || order.items.length === 0) return null;
  if (!READY_IMPLIED_STATUSES.includes(status)) return null;

  const notes = `Order marked "${status}"`;
  markAllReady(order, actor, { source, notes });

  let collection = null;
  if (COLLECTED_IMPLIED_STATUSES.includes(status)) {
    const outstanding = order.items
      .filter((i) => (i.collectedQuantity || 0) < i.quantity)
      .map((i) => ({ itemId: i._id, quantity: i.quantity - (i.collectedQuantity || 0) }));
    if (outstanding.length) {
      collection = applyCollect(order, outstanding, actor, {
        method: source === 'delivery_scan' ? 'delivery' : 'status_update',
        source,
        notes,
      });
    }
  }
  applyCounters(order);
  return collection;
}

/**
 * Save an order whose status was changed by the existing status controls,
 * together with any collection the change implies, as one unit.
 */
async function saveWithStatusSync(order, collection) {
  guardVersion(order);
  try {
    return await withOptionalTransaction(async (session) => {
      let saved = null;
      if (collection) {
        [saved] = await OrderCollection.create([collection], { session });
      }
      try {
        await order.save({ session });
      } catch (err) {
        if (saved && !session) await OrderCollection.deleteOne({ _id: saved._id }).catch(() => {});
        throw err;
      }
      return saved;
    });
  } catch (err) {
    if (isConcurrencyConflict(err)) throw conflictError();
    throw err;
  } finally {
    order.$where = null;
  }
}

// ── Notifications ────────────────────────────────────────────────────────────

async function customerIdFor(order) {
  if (order.customerId) return String(order.customerId);
  if (!order.customer) return null;
  const user = await User.findById(order.customer).select('customerId').lean();
  return user?.customerId ? String(user.customerId) : null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Tell the customer about a readiness milestone or a collection. Sent once per
 * milestone (first garments ready, everything ready) and once per collection —
 * never per garment. Failures are logged, never thrown.
 */
async function notifyFulfilment(io, order, changes, { collection } = {}) {
  try {
    const customerId = await customerIdFor(order);
    const total = order.totalGarments || 0;
    const ready = order.readyGarments || 0;
    const collected = order.collectedGarments || 0;
    const metadata = { orderId: order._id, orderNumber: order.orderNumber, fulfilmentStatus: order.fulfilmentStatus };
    const stamps = {};

    if (collection && customerId) {
      const waiting = ready - collected;
      const processing = total - ready;
      let body;
      if (collected >= total) {
        body = `You've collected all ${plural(total, 'item')} from order ${order.orderNumber}. Thank you!`;
      } else {
        const rest = [
          waiting > 0 ? `${plural(waiting, 'item')} ${waiting === 1 ? 'is' : 'are'} ready and waiting for you` : null,
          processing > 0 ? `${processing} ${processing === 1 ? 'is' : 'are'} still being processed` : null,
        ].filter(Boolean).join(', and ');
        body = `You collected ${plural(collection.totalQuantity, 'item')} from order ${order.orderNumber}.${rest ? ` ${rest.charAt(0).toUpperCase()}${rest.slice(1)}.` : ''}`;
      }
      await notify(io, {
        type: 'order_status_updated',
        title: collected >= total ? 'Order Collected' : 'Items Collected',
        body,
        customerId,
        metadata: { ...metadata, collectionId: collection._id, sequence: collection.sequence },
      });
    }

    if (changes.becameFullyReady && !order.readyNotifications?.fullAt) {
      if (customerId) {
        await notify(io, {
          type: 'order_status_updated',
          title: 'Order Ready',
          body: `Your entire order ${order.orderNumber} is ready — all ${plural(total, 'item')}.`,
          customerId,
          metadata,
        });
      }
      stamps['readyNotifications.fullAt'] = new Date();
    } else if (changes.becamePartiallyReady && !order.readyNotifications?.partialAt) {
      if (customerId) {
        await notify(io, {
          type: 'order_status_updated',
          title: 'Some Items Ready',
          body: `${ready} of ${plural(total, 'item')} in your order ${order.orderNumber} ${ready === 1 ? 'is' : 'are'} ready. We'll let you know when the rest are done.`,
          customerId,
          metadata,
        });
      }
      stamps['readyNotifications.partialAt'] = new Date();
    }

    // The order just became ready through its garments rather than the status
    // control — tell the delivery team exactly as a status change would.
    if (changes.statusChangedTo === 'ready') {
      await notify(io, {
        type: 'order_ready_for_delivery',
        title: '📦 Order Ready for Delivery',
        body: `Order ${order.orderNumber} has been processed and is ready for delivery.`,
        room: 'delivery',
        metadata: { orderId: order._id, orderNumber: order.orderNumber },
      });
    }

    // Stamp outside the version guard: this is bookkeeping, not garment state.
    if (Object.keys(stamps).length) {
      await Order.updateOne({ _id: order._id }, { $set: stamps });
    }
  } catch (err) {
    logger.error(`[orderFulfilment] Notification failed for ${order.orderNumber}: ${err.message}`);
  }
}

module.exports = {
  READY_IMPLIED_STATUSES,
  COLLECTED_IMPLIED_STATUSES,
  PRE_READY_STATUSES,
  deriveFulfilmentStatus,
  summarizeFulfilment,
  applyCounters,
  initialTrackingFields,
  versionFilter,
  guardVersion,
  saveGuarded,
  isConcurrencyConflict,
  conflictError,
  withOptionalTransaction,
  ensureTracking,
  applyReady,
  markAllReady,
  applyCollect,
  settleOrderStatus,
  runFulfilmentChange,
  syncFulfilmentForStatus,
  saveWithStatusSync,
  notifyFulfilment,
  paymentSettled,
};
