const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    planName: { type: String },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
    status: {
      type: String,
      enum: ['active', 'paused', 'past_due', 'expired', 'cancelled'],
      default: 'active',
    },
    autoRenew: { type: Boolean, default: true },
    periodStart: { type: Date, default: Date.now },
    periodEnd: { type: Date },
    nextBilling: { type: Date },
  },
  { timestamps: true }
);

SubscriptionSchema.index({ customerId: 1, status: 1 });

module.exports = mongoose.model('Subscription', SubscriptionSchema);
