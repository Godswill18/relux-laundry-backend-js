// Staff alerts for the Service SLA. Read-only with respect to the order: it
// never changes a status and never marks anything ready — an overdue order
// stays overdue until a person finishes it. Each order is alerted at most once
// per milestone (due soon, overdue), tracked by a stamp claimed atomically so
// workers and restarts cannot double-send.

const Order = require('../models/Order.js');
const notify = require('./notify.js');
const logger = require('./logger.js');
const { acquireJobLock } = require('./jobLock.js');
const { slaFilter } = require('./orderSla.js');

const INTERVAL = 60 * 1000;
const OPEN = { $nin: ['cancelled', 'delivered', 'completed'] };

async function sweep(io, now = new Date()) {
  // Overdue first so an order that skipped "due soon" is not announced twice.
  const overdue = await Order.find({
    status: OPEN, ...slaFilter('overdue', now), 'slaNotified.overdueAt': { $exists: false },
  }).select('_id orderNumber slaDueAt').limit(200).lean();

  for (const o of overdue) {
    const claimed = await Order.updateOne(
      { _id: o._id, 'slaNotified.overdueAt': { $exists: false } },
      { $set: { 'slaNotified.overdueAt': now, 'slaNotified.dueSoonAt': now } }
    );
    if (!claimed.modifiedCount) continue;
    await notify(io, {
      type: 'order_overdue',
      title: 'Order overdue',
      body: `Order ${o.orderNumber} has passed its processing deadline.`,
      room: 'admin',
      metadata: { orderId: o._id, orderNumber: o.orderNumber },
    });
  }

  const soon = await Order.find({
    status: OPEN, ...slaFilter('due_soon', now),
    'slaNotified.dueSoonAt': { $exists: false },
  }).select('_id orderNumber slaDueAt').limit(200).lean();

  for (const o of soon) {
    const claimed = await Order.updateOne(
      { _id: o._id, 'slaNotified.dueSoonAt': { $exists: false } },
      { $set: { 'slaNotified.dueSoonAt': now } }
    );
    if (!claimed.modifiedCount) continue;
    await notify(io, {
      type: 'order_due_soon',
      title: 'Order due soon',
      body: `Order ${o.orderNumber} is close to its processing deadline.`,
      room: 'admin',
      metadata: { orderId: o._id, orderNumber: o.orderNumber },
    });
  }
}

function startSlaMonitor(io) {
  setInterval(async () => {
    try {
      if (!(await acquireJobLock('slaMonitor', INTERVAL * 3))) return;
      await sweep(io);
    } catch (err) {
      logger.error(`[slaMonitor] ${err.message}`);
    }
  }, INTERVAL);
}

module.exports = { startSlaMonitor, sweep };
