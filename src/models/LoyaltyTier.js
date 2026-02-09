const mongoose = require('mongoose');

const LoyaltyTierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    pointsRequired: { type: Number, default: 0 },
    multiplierPercent: { type: Number, default: 100 },
    rank: { type: Number, default: 1 },
    freePickup: { type: Boolean, default: false },
    freeDelivery: { type: Boolean, default: false },
    priorityTurnaround: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

LoyaltyTierSchema.index({ rank: 1 });

module.exports = mongoose.model('LoyaltyTier', LoyaltyTierSchema);
