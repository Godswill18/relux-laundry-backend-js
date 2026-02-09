const mongoose = require('mongoose');

const SubscriptionUsageSchema = new mongoose.Schema(
  {
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    usedQuantity: { type: Number, default: 0 },
  },
  { timestamps: true }
);

SubscriptionUsageSchema.index({ subscriptionId: 1, periodStart: 1 }, { unique: true });

module.exports = mongoose.model('SubscriptionUsage', SubscriptionUsageSchema);
