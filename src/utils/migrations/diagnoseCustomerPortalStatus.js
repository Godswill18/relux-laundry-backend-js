// ─── Diagnose customer portal status — READ-ONLY ────────────────────────────
//
//   node src/utils/migrations/diagnoseCustomerPortalStatus.js
//
// Writes nothing. Only reads and counts. Prints counts and record ids — no
// names, phone numbers or emails.
//
// Answers, from the real data:
//   1. How many customers the PREVIOUS rule showed as "Not Activated" versus
//      the corrected rule, and where the difference comes from.
//   2. Whether the account ↔ customer-record links (users.customerId) are
//      healthy — the join every status depends on.
//   3. How many people appear twice (an account's record + a separate walk-in
//      record with the same phone/email).
//
// The corrected counts come from the same pipeline the app uses
// (utils/customerQueries), so they are exactly what the admin screens show.

require('dotenv').config();
const mongoose = require('mongoose');
const Customer = require('../../models/Customer.js');
const User = require('../../models/User.js');
const Order = require('../../models/Order.js');
const normalizePhone = require('../normalizePhone.js');
const { normalizeEmail } = require('../customerIdentity.js');
const { customerBasePipeline } = require('../customerQueries.js');

const line = (label, value) => console.log(`  ${label.padEnd(62, '.')} ${value}`);

(async () => {
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI is not set.'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected (read-only diagnostic — nothing will be written)\n');

  // ── 1. Account ↔ customer-record links ────────────────────────────────────
  console.log('1. Portal accounts (users with role "customer")');
  const [users] = await User.aggregate([
    { $match: { role: 'customer' } },
    { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'rec' } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        noCustomerId: { $sum: { $cond: [{ $ifNull: ['$customerId', false] }, 0, 1] } },
        wrongType: { $sum: { $cond: [{ $and: [{ $ifNull: ['$customerId', false] }, { $ne: [{ $type: '$customerId' }, 'objectId'] }] }, 1, 0] } },
        dangling: { $sum: { $cond: [{ $and: [{ $ifNull: ['$customerId', false] }, { $eq: [{ $size: '$rec' }, 0] }] }, 1, 0] } },
        deactivated: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
        emailVerifiedFalse: { $sum: { $cond: [{ $eq: ['$emailVerified', false] }, 1, 0] } },
        emailVerifiedMissing: { $sum: { $cond: [{ $eq: [{ $type: '$emailVerified' }, 'missing'] }, 1, 0] } },
      },
    },
  ]);
  const u = users || {};
  line('portal accounts', u.total || 0);
  line('  with no customerId (no record linked yet)', u.noCustomerId || 0);
  line('  customerId not stored as an ObjectId (join cannot match)', u.wrongType || 0);
  line('  customerId pointing at a record that does not exist', u.dangling || 0);
  line('  deactivated', u.deactivated || 0);
  line('  emailVerified = false (signup never finished)', u.emailVerifiedFalse || 0);
  line('  emailVerified missing (predate email verification → Activated)', u.emailVerifiedMissing || 0);

  // ── 2. Old rule vs corrected rule ─────────────────────────────────────────
  const rows = await Customer.aggregate([
    ...customerBasePipeline(),
    { $project: { portalStatus: 1, hasPortalAccount: 1, hasWalkInHistory: 1, hasContact: 1, phone: 1, email: 1, needsReview: 1 } },
  ]);

  const count = (f) => rows.filter(f).length;
  // The PREVIOUS rule: every record without an account was "Not Activated".
  const oldNotActivated = count((r) => !r.hasPortalAccount && r.portalStatus !== 'DEACTIVATED');
  const newNotActivated = count((r) => r.portalStatus === 'UNREGISTERED');

  console.log('\n2. Customers (unique customer records, staff excluded)');
  line('total customers', rows.length);
  line('Activated (has a portal account)', count((r) => r.portalStatus === 'ACTIVE'));
  line('Pending Activation (account, signup unfinished)', count((r) => r.portalStatus === 'PENDING_VERIFICATION'));
  line('Deactivated', count((r) => r.portalStatus === 'DEACTIVATED'));
  line('Not Activated — PREVIOUS rule (any record without an account)', oldNotActivated);
  line('Not Activated — CORRECTED rule (walk-in + phone/email)', newNotActivated);
  line('No Online Account (no walk-in history or no contact details)', count((r) => r.portalStatus === 'NOT_ELIGIBLE'));
  line('  of which: no walk-in history', count((r) => r.portalStatus === 'NOT_ELIGIBLE' && !r.hasWalkInHistory));
  line('  of which: walk-in, but no phone or email', count((r) => r.portalStatus === 'NOT_ELIGIBLE' && r.hasWalkInHistory && !r.hasContact));
  line('flagged for review (needsReview)', count((r) => r.needsReview));

  // ── 3. Same person twice ──────────────────────────────────────────────────
  // A walk-in record with no account whose phone/email equals a registered
  // account's phone/email — shown once as Activated and once as Not Activated.
  const accounts = await User.find({ role: 'customer', customerId: { $ne: null } }).select('phone email customerId').lean();
  const acctPhone = new Map(), acctEmail = new Map();
  for (const a of accounts) {
    const p = normalizePhone(a.phone); if (p) acctPhone.set(p, String(a.customerId));
    const e = normalizeEmail(a.email); if (e) acctEmail.set(e, String(a.customerId));
  }
  const splits = [];
  for (const r of rows) {
    if (r.hasPortalAccount) continue;
    const viaPhone = acctPhone.get(normalizePhone(r.phone));
    const viaEmail = acctEmail.get(normalizeEmail(r.email));
    const other = viaPhone || viaEmail;
    if (other && other !== String(r._id)) splits.push({ walkInRecord: String(r._id), accountRecord: other, via: viaPhone ? 'phone' : 'email' });
  }
  console.log('\n3. Same person appearing twice');
  line('walk-in record matching a registered account', splits.length);
  line('  matched by email (verified email → safe to link)', splits.filter((x) => x.via === 'email').length);
  line('  matched by phone only (account phone unverified → review)', splits.filter((x) => x.via === 'phone').length);
  if (splits.length) console.log('  record ids (no personal data):', JSON.stringify(splits.slice(0, 25)));

  // ── 4. Walk-in orders not yet on a customer record ────────────────────────
  const unlinked = await Order.countDocuments({ orderSource: 'offline', $or: [{ customerId: null }, { customerId: { $exists: false } }] });
  console.log('\n4. Walk-in orders');
  line('walk-in orders with no customer record yet (run linkWalkInCustomers)', unlinked);

  console.log('\nNothing was written.');
  await mongoose.disconnect();
})().catch((err) => { console.error('Diagnostic failed:', err.message); process.exit(1); });
