const mongoose = require('mongoose');

const WalletTransactionSchema = new mongoose.Schema(
  {
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: 'Wallet', required: true },
    amount: { type: Number, required: true },
    type: { type: String, enum: ['credit', 'debit'], required: true },
    reason: { type: String },
  },
  { timestamps: true }
);

WalletTransactionSchema.index({ walletId: 1, createdAt: -1 });

module.exports = mongoose.model('WalletTransaction', WalletTransactionSchema);
