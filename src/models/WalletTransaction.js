const mongoose = require('mongoose');

const WalletTransactionSchema = new mongoose.Schema(
  {
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
    amount: { type: Number, required: true },
    type: { type: String, enum: ['credit', 'debit'], required: true },
    reason: { type: String },
    balanceAfter: { type: Number },
    // Source of the transaction for audit trail
    source: { type: String, enum: ['paystack', 'admin', 'order', 'referral', 'loyalty', 'manual'], default: 'manual' },
    // Paystack reference when source = 'paystack'
    paystackReference: { type: String },
  },
  { timestamps: true }
);

WalletTransactionSchema.index({ walletId: 1, createdAt: -1 });
// Unique sparse index: prevents double-credit if processSuccessful runs concurrently
WalletTransactionSchema.index({ paystackReference: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);
