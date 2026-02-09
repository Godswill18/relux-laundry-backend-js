const mongoose = require('mongoose');

const PaystackTransactionSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'NGN' },
    type: {
      type: String,
      enum: ['order', 'wallet_topup', 'subscription'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'cancelled'],
      default: 'pending',
    },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan' },
    autoRenew: { type: Boolean },
    metadata: { type: mongoose.Schema.Types.Mixed },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

PaystackTransactionSchema.index({ customerId: 1 });
PaystackTransactionSchema.index({ orderId: 1 });
PaystackTransactionSchema.index({ planId: 1 });
PaystackTransactionSchema.index({ type: 1 });
PaystackTransactionSchema.index({ status: 1 });

module.exports = mongoose.model('PaystackTransaction', PaystackTransactionSchema);
