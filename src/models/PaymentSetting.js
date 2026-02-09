const mongoose = require('mongoose');

const PaymentSettingSchema = new mongoose.Schema(
  {
    enableWallet: { type: Boolean, default: true },
    redemptionEnabled: { type: Boolean, default: true },
    enablePaystack: { type: Boolean, default: true },
    enableLenco: { type: Boolean, default: false },
    enableCash: { type: Boolean, default: true },
    enablePos: { type: Boolean, default: true },
    enableTransfer: { type: Boolean, default: true },
    paystackPublicKey: { type: String },
    paystackSecretKey: { type: String, select: false },
    lencoPublicKey: { type: String },
    lencoSecretKey: { type: String, select: false },
    walletMinTopUp: { type: Number, default: 0 },
    walletMaxTopUp: { type: Number },
    walletAutoPayEnabled: { type: Boolean, default: true },
    maxRedeemPointsPerOrder: { type: Number },
    bonusFirstOrderPoints: { type: Number, default: 0 },
    staffConfirmCash: { type: Boolean, default: true },
    staffConfirmPos: { type: Boolean, default: true },
    staffConfirmTransfer: { type: Boolean, default: true },
    staffConfirmPaystack: { type: Boolean, default: false },
    requireReferenceForCash: { type: Boolean, default: false },
    requireReferenceForPos: { type: Boolean, default: true },
    requireReferenceForTransfer: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaymentSetting', PaymentSettingSchema);
