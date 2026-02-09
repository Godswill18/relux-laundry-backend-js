const mongoose = require('mongoose');

const DeliveryZoneSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    fee: { type: Number, default: 0 },
    rushFee: { type: Number, default: 0 },
    radiusKm: { type: Number },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

DeliveryZoneSchema.index({ active: 1 });

module.exports = mongoose.model('DeliveryZone', DeliveryZoneSchema);
