// ─── Backfill: give historical walk-in orders a customer record ─────────────
//
//   node src/utils/migrations/linkWalkInCustomers.js                  # dry run (default) — reads only
//   MIGRATION_CONFIRM_DB=<db-name> node src/utils/migrations/linkWalkInCustomers.js --apply
//
// TAKE A BACKUP FIRST (mongodump) before --apply.
//
// Why: walk-in orders used to be saved with customerId = null unless the phone
// matched a registered account, so walk-in customers were counted nowhere and
// had no record to activate. New orders now always get a customer record; this
// does the same for the orders already in the database.
//
// What it does, per walk-in order with no customerId:
//   1. If the order is already linked to a portal account that has a customer
//      record, use that record.
//   2. Otherwise match an existing customer record by normalized phone/email.
//   3. Otherwise create one (status 'guest', source 'walk_in' = portal
//      UNREGISTERED). Orders sharing a phone share one new record.
//
// What it will NOT do:
//   • match or merge by name — names are not unique;
//   • touch an order whose phone and email point to two different records
//     (reported as an identity conflict for a person to resolve);
//   • invent a record for an order with no phone and no email (reported);
//   • merge customer records — likely duplicates are only FLAGGED (needsReview);
//   • change any amount, payment, wallet, loyalty or referral data;
//   • set order.customer (portal visibility follows from the customer record).
//
// Idempotent: only orders with no customerId are considered, so a second run
// finds nothing new to do.

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../../models/Order.js');
const Customer = require('../../models/Customer.js');
const User = require('../../models/User.js');
const AuditLog = require('../../models/AuditLog.js');
const normalizePhone = require('../normalizePhone.js');
const { normalizeEmail, phoneVariants } = require('../customerIdentity.js');

const APPLY = process.argv.includes('--apply');
const LOCAL = ['localhost', '127.0.0.1', '::1', '[::1]'];

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
      '  MIGRATION_CONFIRM_DB=<database-name> node src/utils/migrations/linkWalkInCustomers.js --apply'
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY — writing changes' : 'DRY RUN — no changes will be written'}\n`);

  const report = {
    ordersConsidered: 0,
    linkedViaAccount: 0,
    linkedToExistingRecord: 0,
    linkedToNewRecord: 0,
    newRecordsCreated: 0,
    identityConflicts: [],
    noIdentifier: [],
    duplicateGroups: [],
  };

  // ── 1. Likely duplicate customer records (flag only) ─────────────────────
  const all = await Customer.find({}).select('_id name phone email').lean();
  const byPhone = new Map(), byEmail = new Map();
  for (const c of all) {
    const p = normalizePhone(c.phone);
    if (p) byPhone.set(p, [...(byPhone.get(p) || []), c._id]);
    const e = normalizeEmail(c.email);
    if (e) byEmail.set(e, [...(byEmail.get(e) || []), c._id]);
  }
  for (const [key, ids] of [...byPhone, ...byEmail]) {
    if (ids.length > 1) report.duplicateGroups.push({ identifier: key.includes('@') ? 'email' : 'phone', count: ids.length, customerIds: ids.map(String) });
  }
  if (APPLY) {
    for (const g of report.duplicateGroups) {
      await Customer.updateMany(
        { _id: { $in: g.customerIds } },
        {
          $set: { needsReview: true, reviewReason: `potential duplicate: same normalized ${g.identifier}` },
          $addToSet: { reviewRelatedCustomerIds: { $each: g.customerIds.map((i) => new mongoose.Types.ObjectId(i)) } },
        }
      );
    }
  }

  // ── 2. Walk-in orders without a customer record ──────────────────────────
  const orders = await Order.find({
    orderSource: 'offline',
    $or: [{ customerId: null }, { customerId: { $exists: false } }],
  }).select('_id orderNumber customer walkInCustomer createdAt').sort('createdAt').lean();
  report.ordersConsidered = orders.length;

  const createdByPhone = new Map(); // one new record per phone within this run
  const ops = [];

  for (const o of orders) {
    // 1. Already on a portal account that has a customer record
    if (o.customer) {
      const u = await User.findById(o.customer).select('customerId role').lean();
      if (u?.customerId && u.role === 'customer') {
        ops.push({ updateOne: { filter: { _id: o._id, customerId: null }, update: { $set: { customerId: u.customerId } } } });
        report.linkedViaAccount++;
        continue;
      }
    }

    const phone = normalizePhone(o.walkInCustomer?.phone) || (o.walkInCustomer?.phone || '').trim() || null;
    const email = normalizeEmail(o.walkInCustomer?.email);
    if (!phone && !email) {
      report.noIdentifier.push(o.orderNumber);
      continue;
    }

    // 2. Existing record by phone/email
    const [pMatch, eMatch] = await Promise.all([
      phone ? Customer.findOne({ phone: { $in: phoneVariants(phone) } }).select('_id').lean() : null,
      email ? Customer.findOne({ email }).select('_id').lean() : null,
    ]);
    if (pMatch && eMatch && String(pMatch._id) !== String(eMatch._id)) {
      report.identityConflicts.push({ order: o.orderNumber, phoneRecord: String(pMatch._id), emailRecord: String(eMatch._id) });
      continue;
    }
    const existing = pMatch || eMatch;
    if (existing) {
      ops.push({ updateOne: { filter: { _id: o._id, customerId: null }, update: { $set: { customerId: existing._id } } } });
      report.linkedToExistingRecord++;
      continue;
    }

    // 3. Create (once per phone in this run)
    const key = phone || email;
    let newId = createdByPhone.get(key);
    if (!newId) {
      report.newRecordsCreated++;
      if (APPLY) {
        const created = await Customer.create({
          name: (o.walkInCustomer?.name || '').trim() || 'Walk-in customer',
          phone: phone || undefined,
          email: email || undefined,
          status: 'guest',
          source: 'walk_in',
          // Dated to their first order, so a one-off backfill does not show
          // every historical walk-in as a "new customer this month".
          createdAt: o.createdAt,
        });
        newId = created._id;
        await AuditLog.create({
          action: 'CUSTOMER_CREATED_FROM_WALK_IN',
          targetType: 'Customer',
          targetId: String(newId),
          metadata: { via: 'linkWalkInCustomers migration', firstOrder: o.orderNumber },
        });
      } else {
        newId = `new:${key}`;
      }
      createdByPhone.set(key, newId);
    }
    if (APPLY) ops.push({ updateOne: { filter: { _id: o._id, customerId: null }, update: { $set: { customerId: newId } } } });
    report.linkedToNewRecord++;
  }

  if (APPLY && ops.length) await Order.bulkWrite(ops, { ordered: false });

  if (APPLY) {
    await AuditLog.create({
      action: 'WALK_IN_CUSTOMER_BACKFILL',
      targetType: 'Migration',
      targetId: 'linkWalkInCustomers',
      metadata: {
        ordersConsidered: report.ordersConsidered,
        linkedViaAccount: report.linkedViaAccount,
        linkedToExistingRecord: report.linkedToExistingRecord,
        linkedToNewRecord: report.linkedToNewRecord,
        newRecordsCreated: report.newRecordsCreated,
        identityConflicts: report.identityConflicts.length,
        noIdentifier: report.noIdentifier.length,
        duplicateGroupsFlagged: report.duplicateGroups.length,
      },
    });
  }

  console.log('Walk-in orders without a customer record:', report.ordersConsidered);
  console.log('  → linked through their existing portal account :', report.linkedViaAccount);
  console.log('  → linked to an existing customer record        :', report.linkedToExistingRecord);
  console.log('  → linked to a NEW customer record              :', report.linkedToNewRecord, `(${report.newRecordsCreated} record(s) ${APPLY ? 'created' : 'would be created'})`);
  console.log('  → skipped, phone and email on different records:', report.identityConflicts.length);
  console.log('  → skipped, no phone or email to identify them  :', report.noIdentifier.length);
  console.log('\nLikely duplicate customer records (same normalized phone/email):', report.duplicateGroups.length, APPLY ? '— flagged needsReview' : '— would be flagged');
  if (report.identityConflicts.length) console.log('\nIdentity conflicts (resolve by hand):', JSON.stringify(report.identityConflicts.slice(0, 50), null, 2));
  if (report.noIdentifier.length) console.log('\nOrders with no phone/email:', report.noIdentifier.slice(0, 50).join(', '));
  if (!APPLY) console.log('\nNothing was written. Take a backup, then re-run with --apply.');

  await mongoose.disconnect();
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
