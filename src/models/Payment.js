const mongoose = require('mongoose');

const PaymentSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    amount: { type: Number, required: true },
    method: {
      type: String,
      enum: ['wallet', 'paystack', 'cash', 'pos', 'transfer'],
      required: true,
    },
    state: {
      type: String,
      enum: ['pending', 'paid', 'failed'],
      default: 'pending',
    },
    reference: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    paidAt: { type: Date },
    confirmedById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

PaymentSchema.index({ method: 1 });
PaymentSchema.index({ state: 1 });

module.exports = mongoose.model('Payment', PaymentSchema);
