const mongoose = require('mongoose');

const WalletSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, unique: true },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Wallet', WalletSchema);
