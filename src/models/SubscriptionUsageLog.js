const mongoose = require('mongoose');

const SubscriptionUsageLogSchema = new mongoose.Schema(
  {
    subscriptionUsageId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionUsage', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    quantity: { type: Number, required: true },
  },
  { timestamps: true }
);

SubscriptionUsageLogSchema.index({ subscriptionUsageId: 1 });

module.exports = mongoose.model('SubscriptionUsageLog', SubscriptionUsageLogSchema);
