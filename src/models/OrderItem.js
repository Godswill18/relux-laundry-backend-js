const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    serviceCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceCategory', required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true },
    subtotal: { type: Number, required: true },
    careType: {
      type: String,
      enum: ['wash_only', 'iron_only', 'wash_and_iron'],
      default: 'wash_and_iron',
    },
    serviceLevel: {
      type: String,
      enum: ['standard', 'express', 'premium'],
      default: 'standard',
    },
  },
  { timestamps: true }
);

OrderItemSchema.index({ orderId: 1 });

module.exports = mongoose.model('OrderItem', OrderItemSchema);
