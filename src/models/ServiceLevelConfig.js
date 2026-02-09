const mongoose = require('mongoose');

const ServiceLevelConfigSchema = new mongoose.Schema(
  {
    level: {
      type: String,
      enum: ['standard', 'express', 'premium'],
      required: true,
      unique: true,
    },
    priceMultiplier: { type: Number, default: 100 },
    durationHours: { type: Number, default: 48 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ServiceLevelConfig', ServiceLevelConfigSchema);
