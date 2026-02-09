const mongoose = require('mongoose');

const CustomerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, unique: true, sparse: true, trim: true },
    email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    address: { type: String },
    city: { type: String },
    dateOfBirth: { type: Date },
    photoUrl: { type: String },
    status: {
      type: String,
      enum: ['guest', 'active', 'suspended'],
      default: 'guest',
    },
    loyaltyPointsBalance: { type: Number, default: 0 },
    loyaltyLifetimePoints: { type: Number, default: 0 },
    loyaltyTierId: { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyTier' },
  },
  { timestamps: true }
);

CustomerSchema.index({ status: 1 });

module.exports = mongoose.model('Customer', CustomerSchema);
