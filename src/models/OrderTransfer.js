const mongoose = require('mongoose');

// A request to move ONE order to another customer account.
//
// These states belong to the transfer request only — they are never order
// statuses. The verification code is never stored, only an HMAC bound to this
// request, its order, the destination phone and the destination account.
// Completed records are kept permanently as the history of the move.
const TRANSFER_STATES = ['PENDING_VERIFICATION', 'PENDING_ACCOUNT', 'COMPLETED', 'FAILED', 'CANCELLED'];

const OrderTransferSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String },
    // Set only while the request is open: the unique index on it is what makes
    // a second open request for the same order impossible, even in a race.
    openOrderId: { type: mongoose.Schema.Types.ObjectId },

    status: { type: String, enum: TRANSFER_STATES, required: true },

    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    fromCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    previousPhone: { type: String },

    toPhone: { type: String, required: true }, // normalized
    toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    toCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // 'email' = code sent to the destination account's verified email address.
    // There is no SMS provider yet; a future one adds a channel here.
    channel: { type: String, enum: ['email'] },
    codeHash: { type: String, select: false },
    expiresAt: { type: Date },
    attempts: { type: Number, default: 0 },
    codesSent: { type: Number, default: 0 },
    lastSentAt: { type: Date },

    verifiedAt: { type: Date },
    completedAt: { type: Date },
    failureReason: { type: String },
  },
  { timestamps: true }
);

OrderTransferSchema.index({ openOrderId: 1 }, { unique: true, sparse: true });
OrderTransferSchema.index({ orderId: 1, createdAt: -1 });
OrderTransferSchema.index({ toPhone: 1, status: 1 });

module.exports = mongoose.model('OrderTransfer', OrderTransferSchema);
module.exports.TRANSFER_STATES = TRANSFER_STATES;
