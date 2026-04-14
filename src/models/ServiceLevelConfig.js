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
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ServiceLevelConfig', ServiceLevelConfigSchema);
