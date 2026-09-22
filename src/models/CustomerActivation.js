const mongoose = require('mongoose');

// One-time verification for an existing customer activating a portal account.
//
// The code itself is never stored — only an HMAC of it — and a record is
// single-use: `usedAt` is set the moment an account is created from it.
// Attempts are counted per record so a code cannot be brute-forced even when
// requests arrive from many IP addresses.
const CustomerActivationSchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    channel:    { type: String, enum: ['email'], required: true },
    codeHash:   { type: String, required: true },
    expiresAt:  { type: Date, required: true },
    attempts:   { type: Number, default: 0 },
    verifiedAt: { type: Date },
    usedAt:     { type: Date },
    requestIp:  { type: String },
  },
  { timestamps: true }
);

CustomerActivationSchema.index({ customerId: 1, createdAt: -1 });
// Expired attempts are cleaned up by MongoDB a day after they lapse.
CustomerActivationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('CustomerActivation', CustomerActivationSchema);
