// ─── One-time migration: align the order-redemption rate ─────────────────────
//
//   node src/utils/migrations/alignRedemptionRate.js          # dry run, prints only
//   node src/utils/migrations/alignRedemptionRate.js --apply  # writes the change
//
// Why this exists
// ---------------
// Order discounts were priced from `pointsRedemptionValue`, a ₦-per-point field
// that the admin dashboard never rendered, so it sat at its schema default of 5
// (₦5 per point) forever. The wallet page used `walletConversionRate`, a
// points-per-₦1 field the admin *did* control. An admin configuring "5 points =
// ₦1" therefore got ₦0.20/point on the wallet page and ₦5.00/point at checkout —
// the same digit, opposite units, a 25× gap.
//
// Redemption now reads `redemptionPointsPerCurrency`, which was already declared
// on the schema in the correct unit and read by nothing. This sets it equal to
// the configured wallet rate, so one rate governs both channels.
//
// Safe to run more than once. Touches exactly one settings document and no
// customer balance, ledger row, wallet or order.

require('dotenv').config();
const mongoose = require('mongoose');
const LoyaltySetting = require('../../models/LoyaltySetting.js');

const APPLY = process.argv.includes('--apply');

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const settings = await LoyaltySetting.findOne();
  if (!settings) {
    console.log('No LoyaltySetting document exists yet — nothing to migrate.');
    console.log('One will be created with consistent defaults on first use.');
    await mongoose.disconnect();
    return;
  }

  const walletRate  = Number(settings.walletConversionRate) > 0 ? Number(settings.walletConversionRate) : 100;
  const currentRedeem = Number(settings.redemptionPointsPerCurrency);
  const legacyValue = Number(settings.pointsRedemptionValue);

  console.log('Current configuration');
  console.log('---------------------');
  console.log(`  walletConversionRate         : ${walletRate}  (${walletRate} pts = ₦1)`);
  console.log(`  redemptionPointsPerCurrency  : ${currentRedeem || '(unset)'}`);
  console.log(`  pointsRedemptionValue (old)  : ${legacyValue}  → ₦${legacyValue} per point [DEPRECATED]\n`);

  const effectiveOld = legacyValue > 0 ? legacyValue : 5;
  console.log('Effect on a 400-point redemption');
  console.log('--------------------------------');
  console.log(`  before : ₦${(400 * effectiveOld).toLocaleString()}`);
  console.log(`  after  : ₦${Math.floor(400 / walletRate).toLocaleString()}\n`);

  if (currentRedeem === walletRate) {
    console.log('Already aligned — no change needed.');
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(`DRY RUN — would set redemptionPointsPerCurrency = ${walletRate}`);
    console.log('Re-run with --apply to write the change.');
    await mongoose.disconnect();
    return;
  }

  settings.redemptionPointsPerCurrency = walletRate;
  await settings.save();
  console.log(`Applied. redemptionPointsPerCurrency = ${walletRate}`);
  console.log('\nRollback: set redemptionPointsPerCurrency back to its previous value');
  console.log(`          (was ${currentRedeem || 'unset'}) from the admin dashboard or this shell.`);

  await mongoose.disconnect();
})().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
