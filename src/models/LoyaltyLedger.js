const mongoose = require('mongoose');

const LoyaltyLedgerSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    points: { type: Number, required: true },
    type: {
      type: String,
      enum: ['earn', 'redeem', 'adjust', 'reversal'],
      required: true,
    },
    reason: { type: String },
  },
  { timestamps: true }
);

LoyaltyLedgerSchema.index({ customerId: 1 });
LoyaltyLedgerSchema.index({ orderId: 1 });
LoyaltyLedgerSchema.index({ type: 1 });
LoyaltyLedgerSchema.index({ orderId: 1, type: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('LoyaltyLedger', LoyaltyLedgerSchema);
