const mongoose = require('mongoose');

const LoyaltySettingSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    redemptionEnabled: { type: Boolean, default: true },
    pointsPerCurrency: { type: Number, default: 1 },
    // Points required for ₦1 of ORDER DISCOUNT — same unit as walletConversionRate
    // ("points per ₦1"). This field already existed and was read by nothing; it is
    // now the authoritative redemption rate, exposed in the admin dashboard.
    // Default matches the wallet default so a fresh install is internally consistent.
    redemptionPointsPerCurrency: { type: Number, default: 100 },
    minOrderAmount: { type: Number, default: 0 },
    maxPointsPerOrder: { type: Number },
    maxPointsPerDay: { type: Number },
    minRedeemPoints: { type: Number, default: 100 },
    // DEPRECATED — do not read. This was the ₦ value of one point (the inverse
    // unit of every other rate here). Because it was never rendered in the admin
    // dashboard it sat at its default of 5 forever, meaning ₦5 per point, while
    // the admin configured walletConversionRate: 5 meaning 5 points per ₦1 — a
    // 25× discrepancy between the wallet page and checkout. Redemption now reads
    // redemptionPointsPerCurrency. Kept only so the old value is recoverable on
    // rollback; remove in a later release once the migration has settled.
    pointsRedemptionValue: { type: Number, default: 5 },
    maxRedeemPercent: { type: Number, default: 50 },
    maxRedeemPointsPerOrder: { type: Number },
    redeemIncludesDelivery: { type: Boolean, default: true },
    redeemIncludesAddons: { type: Boolean, default: true },
    qualifyOnStatus: { type: String, enum: ['paid', 'completed'], default: 'completed' },
    allowWithSubscription: { type: Boolean, default: true },
    bonusStandardPercent: { type: Number, default: 100 },
    bonusExpressPercent: { type: Number, default: 120 },
    bonusPremiumPercent: { type: Number, default: 150 },
    bonusFirstOrderPoints: { type: Number, default: 0 },
    bonusSecondOrderPoints: { type: Number, default: 0 },
    weekendMultiplierEnabled: { type: Boolean, default: false },
    weekendMultiplierPercent: { type: Number, default: 200 },
    bonusStainRemoval: { type: Number, default: 0 },
    bonusRush: { type: Number, default: 0 },
    bonusPickupDelivery: { type: Number, default: 0 },
    // Wallet conversion
    walletConversionEnabled: { type: Boolean, default: true },
    walletConversionRate: { type: Number, default: 100 },   // X points = ₦1
    minConvertPoints: { type: Number, default: 100 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LoyaltySetting', LoyaltySettingSchema);
