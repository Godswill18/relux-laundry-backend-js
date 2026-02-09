const mongoose = require('mongoose');

const LoyaltySettingSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    redemptionEnabled: { type: Boolean, default: true },
    pointsPerCurrency: { type: Number, default: 1 },
    redemptionPointsPerCurrency: { type: Number, default: 1 },
    minOrderAmount: { type: Number, default: 0 },
    maxPointsPerOrder: { type: Number },
    maxPointsPerDay: { type: Number },
    minRedeemPoints: { type: Number, default: 100 },
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('LoyaltySetting', LoyaltySettingSchema);
