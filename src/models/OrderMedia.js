const mongoose = require('mongoose');

const OrderMediaSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    mediaUrl: { type: String, required: true },
    source: { type: String, enum: ['customer', 'staff'], required: true },
    note: { type: String },
  },
  { timestamps: true }
);

OrderMediaSchema.index({ orderId: 1 });

module.exports = mongoose.model('OrderMedia', OrderMediaSchema);
