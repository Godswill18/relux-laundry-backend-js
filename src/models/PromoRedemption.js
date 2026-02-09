const mongoose = require('mongoose');

const PromoRedemptionSchema = new mongoose.Schema(
  {
    promoCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    amount: { type: Number, required: true },
  },
  { timestamps: true }
);

PromoRedemptionSchema.index({ promoCodeId: 1 });
PromoRedemptionSchema.index({ customerId: 1 });

module.exports = mongoose.model('PromoRedemption', PromoRedemptionSchema);
