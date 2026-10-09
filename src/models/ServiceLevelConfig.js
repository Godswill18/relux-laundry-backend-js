const mongoose = require('mongoose');

const ServiceLevelConfigSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // Percentage added to the base order total.
    // 0 = no adjustment (normal service), 20 = +20%, 50 = +50%, etc.
    percentageAdjustment: {
      type: Number,
      default: 0,
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
    // Priority level 1–10: staff/admin urgency indicator shown as badge on orders
    // 1-3 = Low, 4-6 = Medium, 7-8 = High, 9-10 = Critical
    priorityLevel: {
      type: Number,
      default: 1,
      min: 1,
      max: 10,
    },
    // Promised processing time in hours, counted from order confirmation.
    // Unset = no timer for this level. Changed only through the Service Level
    // Timer Settings (PUT /services/levels/:id/sla), which is permission-gated
    // and audited; the general level edit ignores it. Copied onto each order at
    // confirmation, so changing it never moves an existing order's deadline.
    slaHours: {
      type: Number,
      min: 0.25,
      max: 720,
    },
    slaUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    slaUpdatedAt: { type: Date },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ServiceLevelConfig', ServiceLevelConfigSchema);
