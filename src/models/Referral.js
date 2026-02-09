const mongoose = require('mongoose');

const ReferralSchema = new mongoose.Schema(
  {
    referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    refereeUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    status: {
      type: String,
      enum: ['pending', 'qualified', 'rewarded', 'reversed', 'rejected'],
      default: 'pending',
    },
    rewardCredited: { type: Boolean, default: false },
    rewardAmount: { type: Number, default: 0 },
    refereeRewardCredited: { type: Boolean, default: false },
    refereeRewardAmount: { type: Number, default: 0 },
    referrerLoyaltyCredited: { type: Boolean, default: false },
    refereeLoyaltyCredited: { type: Boolean, default: false },
    referrerLoyaltyPoints: { type: Number, default: 0 },
    refereeLoyaltyPoints: { type: Number, default: 0 },
  },
  { timestamps: true }
);

ReferralSchema.index({ referrerUserId: 1 });

module.exports = mongoose.model('Referral', ReferralSchema);
