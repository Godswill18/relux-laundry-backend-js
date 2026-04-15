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
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ServiceLevelConfig', ServiceLevelConfigSchema);
