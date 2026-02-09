const mongoose = require('mongoose');

const ReferralSettingSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    referrerRewardAmount: { type: Number, default: 1000 },
    refereeRewardAmount: { type: Number, default: 0 },
    referrerLoyaltyPoints: { type: Number, default: 0 },
    refereeLoyaltyPoints: { type: Number, default: 0 },
    minOrderCount: { type: Number, default: 1 },
    minOrderAmount: { type: Number, default: 0 },
    qualifyOnStatus: { type: String, enum: ['paid', 'completed'], default: 'completed' },
    maxRewardsPerReferrer: { type: Number },
    allowSelfReferral: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReferralSetting', ReferralSettingSchema);
