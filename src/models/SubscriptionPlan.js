const mongoose = require('mongoose');

const SubscriptionPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String },
    price: { type: Number, required: true },
    durationDays: { type: Number, default: 30 },
    itemLimit: { type: Number },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SubscriptionPlan', SubscriptionPlanSchema);
