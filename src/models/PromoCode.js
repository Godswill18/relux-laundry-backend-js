const mongoose = require('mongoose');

const PromoCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ['fixed', 'percent'], required: true },
    value: { type: Number, required: true },
    usageLimit: { type: Number },        // total times across all users (null = unlimited)
    usagePerUser: { type: Number, default: 1 }, // max times one customer can use it
    expiresAt: { type: Date },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PromoCode', PromoCodeSchema);
