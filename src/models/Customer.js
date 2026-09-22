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
    lifetimeSpend: { type: Number, default: 0 },
    loyaltyTierId: { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyTier' },

    // How this record first came into existence. Optional: records created
    // before this field existed simply have none.
    source: { type: String, enum: ['walk_in', 'online', 'admin'] },

    // Data-quality flag for records that may be the same person as another
    // (e.g. a new account whose phone already belongs to a walk-in record).
    // Records are never merged automatically; this marks them for a person to
    // review. Cleared by an admin once resolved.
    needsReview:   { type: Boolean, default: false },
    reviewReason:  { type: String },
    reviewRelatedCustomerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],
  },
  { timestamps: true }
);

CustomerSchema.index({ status: 1 });
CustomerSchema.index({ needsReview: 1 });
CustomerSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Customer', CustomerSchema);
