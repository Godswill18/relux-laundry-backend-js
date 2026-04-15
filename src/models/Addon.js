const mongoose = require('mongoose');

// ── Addon Model ───────────────────────────────────────────────────────────────
// Represents a selectable add-on that can be attached to any order.
// type='fixed'      → value is a flat ₦ amount added to the order total
// type='percentage' → value is a % applied to the order subtotal (items only)
// ─────────────────────────────────────────────────────────────────────────────

const AddonSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // 'fixed' = ₦ flat fee  |  'percentage' = % of order subtotal
    type: {
      type: String,
      enum: ['fixed', 'percentage'],
      required: true,
    },
    // Monetary value (₦) for 'fixed', or percent for 'percentage' (e.g. 10 = 10%)
    value: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      default: '',
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Addon', AddonSchema);
