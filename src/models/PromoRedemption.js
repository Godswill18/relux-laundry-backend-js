const mongoose = require('mongoose');

const PromoRedemptionSchema = new mongoose.Schema(
  {
    promoCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PromoCode', required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    // Optional: an unlinked walk-in has no Customer record. It was required, so
    // walk-in redemptions failed validation and were silently swallowed — the
    // discount applied but the row was never written, meaning a code with a
    // usageLimit could be used at the counter indefinitely. Anonymous
    // redemptions now record with a null customerId so they count toward the
    // global limit; the per-user limit simply cannot apply to them.
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    amount: { type: Number, required: true },
  },
  { timestamps: true }
);

PromoRedemptionSchema.index({ promoCodeId: 1 });
PromoRedemptionSchema.index({ customerId: 1 });

module.exports = mongoose.model('PromoRedemption', PromoRedemptionSchema);
