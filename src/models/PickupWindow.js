const mongoose = require('mongoose');

const PickupWindowSchema = new mongoose.Schema(
  {
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    baseFee: { type: Number, default: 0 },
    rushFee: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

PickupWindowSchema.index({ dayOfWeek: 1 });
PickupWindowSchema.index({ active: 1 });

module.exports = mongoose.model('PickupWindow', PickupWindowSchema);
