#!/usr/bin/env node
// ─── Canonical order status migration ───────────────────────────────────────
//
//   node src/utils/migrations/canonicalOrderStatus.js            # DRY RUN (default): inventory only
//   node src/utils/migrations/canonicalOrderStatus.js --apply    # migrate
//   node src/utils/migrations/canonicalOrderStatus.js --rollback # restore from the audit rows
//
// • Explicit per-value mapping only — no "everything else" UPDATE.
// • Idempotent: it only ever matches the retired values; a second run matches 0.
// • Raw collection writes: no hooks run, updatedAt/confirmedAt/SLA fields are
//   not touched, and no order data other than `status` (and delivery metadata
//   for the two delivery states) changes.
// • Every changed order is recorded in `orderstatusmigrations` {orderId, from,
//   to, at, set} so the change can be audited and reversed per order.
// • statusHistory and audit logs are history and are never rewritten.
//
// TAKE A DATABASE BACKUP (mongodump) BEFORE --apply.

require('dotenv').config();
const mongoose = require('mongoose');
const { ORDER_STATUSES } = require('../orderStatus.js');

// legacy value → { to, set } (set = extra delivery metadata, only where the
// legacy status itself carried that information)
const PLAN = {
  washing:            { to: 'in_progress' },
  ironing:            { to: 'in_progress' },
  'out-for-delivery': { to: 'ready', set: { deliveryStatus: 'out_for_delivery' } },
  'picked-up':        { to: 'confirmed' },
  delivered:          { to: 'completed', set: { deliveryStatus: 'delivered' } },
};

async function inventory(orders) {
  const rows = await orders.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
  return Object.fromEntries(rows.map((r) => [String(r._id), r.n]).sort());
}

async function run({ apply = false, rollback = false, db = mongoose.connection.db, log = console.log } = {}) {
  const orders = db.collection('orders');
  const audit = db.collection('orderstatusmigrations');
  const before = await inventory(orders);
  log('Status inventory BEFORE:', before);

  const unknown = Object.keys(before).filter((s) => !ORDER_STATUSES.includes(s) && !PLAN[s]);
  if (unknown.length) log('NOT MAPPED (left untouched, needs review):', unknown.map((s) => `${s}=${before[s]}`).join(', '));

  const result = { before, unknown, migrated: {}, rolledBack: 0 };

  if (rollback) {
    const rows = await audit.find({ rolledBack: { $ne: true } }).toArray();
    for (const r of rows) {
      const unset = Object.fromEntries(Object.keys(r.set || {}).map((k) => [k, '']));
      await orders.updateOne({ _id: r.orderId, status: r.to }, { $set: { status: r.from }, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      await audit.updateOne({ _id: r._id }, { $set: { rolledBack: true, rolledBackAt: new Date() } });
      result.rolledBack += 1;
    }
    log(`Rolled back ${result.rolledBack} orders`);
    return result;
  }

  for (const [from, { to, set }] of Object.entries(PLAN)) {
    const ids = await orders.find({ status: from }, { projection: { _id: 1 } }).toArray();
    result.migrated[from] = ids.length;
    if (!apply || ids.length === 0) continue;
    const at = new Date();
    await audit.insertMany(ids.map((d) => ({ orderId: d._id, from, to, set: set || null, at })));
    await orders.updateMany({ status: from }, { $set: { status: to, ...(set || {}) } });
  }

  if (apply) {
    const after = await inventory(orders);
    const stray = Object.keys(after).filter((s) => !ORDER_STATUSES.includes(s));
    log('Status inventory AFTER:', after);
    if (stray.length) log('WARNING — non-canonical statuses remain:', stray.join(', '));
    result.after = after;
    result.stray = stray;
  } else {
    log('DRY RUN — would migrate:', result.migrated);
  }
  return result;
}

module.exports = { run, PLAN };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    const res = await run({ apply: process.argv.includes('--apply'), rollback: process.argv.includes('--rollback') });
    await mongoose.disconnect();
    process.exit(res.stray?.length ? 2 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
