const mongoose = require('mongoose');

const PushSubscriptionSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  endpoint:   { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth:   { type: String, required: true },
  },
  userAgent: { type: String },
}, { timestamps: true });

PushSubscriptionSchema.index({ userId: 1 });
PushSubscriptionSchema.index({ customerId: 1 });

module.exports = mongoose.model('PushSubscription', PushSubscriptionSchema);
