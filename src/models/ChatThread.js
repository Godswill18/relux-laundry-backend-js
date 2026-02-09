const mongoose = require('mongoose');

const ChatThreadSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', unique: true, sparse: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    subject: { type: String },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    createdBy: { type: String, enum: ['customer', 'staff'], required: true },
  },
  { timestamps: true }
);

ChatThreadSchema.index({ customerId: 1 });
ChatThreadSchema.index({ status: 1 });

module.exports = mongoose.model('ChatThread', ChatThreadSchema);
