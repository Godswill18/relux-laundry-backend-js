// ─── Backfill: garment tracking for orders placed before it existed ─────────
//
//   node src/utils/migrations/initItemTracking.js                  # dry run (default) — reads only
//   MIGRATION_CONFIRM_DB=<db-name> node src/utils/migrations/initItemTracking.js --apply
//
// TAKE A BACKUP FIRST (mongodump) before --apply.
//
// OPTIONAL. The application works without it: an older order is read from its
// status, and an open one starts tracking the first time staff mark or collect
// garments on it. Running it makes every open order filterable by garment state
// straight away.
//
// Orders already hold their lines in order.items (garment, quantity, service,
// price), so no order is restructured, re-priced or re-numbered. Per order
// without itemTracking:
//
//   every order      totalGarments = sum of line quantities (derived, not new data)
//   OPEN orders      start tracking. Only what the status already asserts is
//   (not cancelled,  recorded: at 'ready' / 'out-for-delivery' every garment is
//   delivered or     ready; anything earlier has none ready. Nothing collected.
//   completed)       A 'tracking_started' event (source: migration) is added.
//   CLOSED orders    left as they are. Their hand-over happened without a record
//   (delivered /     and none is invented — no collection records, no timestamps,
//   completed)       no per-garment counts. They keep reading as "not recorded".
//   cancelled        totalGarments only.
//
// What it will NOT do: change any price, total, payment, status, loyalty or
// customer data; create collection records; touch an order that already has
// itemTracking. Each write is conditional on the order being unchanged since it
// was read, so a live edit during the run is skipped (and reported), never
// overwritten. Idempotent: a second run finds nothing left to do.

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../../models/Order.js');
const {
  READY_IMPLIED_STATUSES,
  deriveFulfilmentStatus,
} = require('../orderFulfilment.js');

const APPLY = process.argv.includes('--apply');
const LOCAL = ['localhost', '127.0.0.1', '::1', '[::1]'];
const CLOSED = ['delivered', 'completed'];

function dbInfo(uri) {
  const rest = uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@/]*@/, '');
  const [hostPart, path = ''] = rest.split(/\/(.*)/s);
  const hosts = hostPart.split(',').map((h) => h.replace(/:\d+$/, '').toLowerCase());
  return {
    dbName: decodeURIComponent(path.split('?')[0] || ''),
    isLocal: !uri.startsWith('mongodb+srv') && hosts.every((h) => LOCAL.includes(h)),
  };
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set — aborting.'); process.exit(1); }

  const { dbName, isLocal } = dbInfo(uri);
  if (APPLY && !isLocal && process.env.MIGRATION_CONFIRM_DB !== dbName) {
    console.error(
      'Refusing to --apply against a remote database without confirmation.\n' +
      'Run the dry run first, take a backup, then confirm by typing the database name:\n' +
      '  MIGRATION_CONFIRM_DB=<database-name> node src/utils/migrations/initItemTracking.js --apply'
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY — writing changes' : 'DRY RUN — no changes will be written'}\n`);

  const report = {
    considered: 0,
    openStarted: 0,
    openStartedAllReady: 0,
    closedLeftAsLegacy: 0,
    cancelled: 0,
    noItems: [],
    changedDuringRun: [],
    garments: 0,
  };

  const coll = Order.collection;
  const cursor = coll.find(
    { itemTracking: { $ne: true } },
    { projection: { orderNumber: 1, status: 1, items: 1, updatedAt: 1, totalGarments: 1 } }
  );

  for await (const order of cursor) {
    report.considered += 1;
    const items = Array.isArray(order.items) ? order.items : [];
    const totalGarments = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    report.garments += totalGarments;

    // Unchanged since read → safe to write; otherwise leave it for the next run.
    const filter = { _id: order._id, itemTracking: { $ne: true }, updatedAt: order.updatedAt };
    const set = { totalGarments };
    let history = null;

    const isOpen = order.status !== 'cancelled' && !CLOSED.includes(order.status);
    if (order.status === 'cancelled') {
      report.cancelled += 1;
    } else if (!isOpen) {
      report.closedLeftAsLegacy += 1;
    } else if (items.length === 0) {
      report.noItems.push(order.orderNumber);
    } else {
      const allReady = READY_IMPLIED_STATUSES.includes(order.status);
      const newItems = items.map((i) => ({
        ...i,
        readyQuantity: allReady ? (Number(i.quantity) || 0) : 0,
        collectedQuantity: 0,
      }));
      const ready = allReady ? totalGarments : 0;
      Object.assign(set, {
        items: newItems,
        itemTracking: true,
        readyGarments: ready,
        collectedGarments: 0,
        fulfilmentStatus: deriveFulfilmentStatus(totalGarments, ready, 0),
        collectionCount: 0,
      });
      history = {
        _id: new mongoose.Types.ObjectId(),
        type: 'tracking_started',
        source: 'migration',
        items: [],
        quantity: ready,
        notes: allReady
          ? `Order was already "${order.status}" — every garment recorded as ready`
          : 'Garment-level tracking started',
        at: new Date(),
      };
      report.openStarted += 1;
      if (allReady) report.openStartedAllReady += 1;
    }

    if (!APPLY) continue;
    // Closed/cancelled order already carrying its garment count: nothing to do
    if (!history && order.totalGarments === totalGarments) continue;

    const update = { $set: set };
    if (history) {
      update.$push = { fulfilmentHistory: history };
      // Moves the version on, so a request that read this order before the
      // migration re-reads it instead of overwriting the new counters.
      update.$inc = { fulfilmentVersion: 1 };
    }
    // Native driver: exact fields only, and updatedAt is left as it was.
    const res = await coll.updateOne(filter, update);
    if (res.matchedCount === 0) report.changedDuringRun.push(order.orderNumber);
  }

  console.log('Orders without garment tracking:', report.considered);
  console.log('  Open → tracking started:           ', report.openStarted,
    `(${report.openStartedAllReady} already ready/out-for-delivery → all garments ready)`);
  console.log('  Closed (delivered/completed) → left as not recorded:', report.closedLeftAsLegacy);
  console.log('  Cancelled → garment count only:    ', report.cancelled);
  console.log('  Total garments across these orders:', report.garments);
  if (report.noItems.length) {
    console.log(`  Open orders with no items (left untracked): ${report.noItems.length}`);
    console.log('   ', report.noItems.slice(0, 30).join(', '), report.noItems.length > 30 ? '…' : '');
  }
  if (report.changedDuringRun.length) {
    console.log(`  Changed while running — skipped, re-run to include: ${report.changedDuringRun.length}`);
    console.log('   ', report.changedDuringRun.slice(0, 30).join(', '));
  }
  if (!APPLY) console.log('\nNothing was written. Take a backup, then re-run with --apply.');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
