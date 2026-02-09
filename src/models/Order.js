const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema({
  itemType: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  description: String,
  condition: String,
});

const StatusHistorySchema = new mongoose.Schema({
  status: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  notes: String,
});

const AddressSchema = new mongoose.Schema({
  street: String,
  landmark: String,
  city: String,
  state: String,
});

const PricingSchema = new mongoose.Schema({
  subtotal: { type: Number, default: 0 },
  pickupFee: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, required: true },
});

const PaymentSchema = new mongoose.Schema({
  method: {
    type: String,
    enum: ['online', 'cash', 'pos', 'wallet'],
    default: 'cash',
  },
  status: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending',
  },
  transactionId: String,
  paidAt: Date,
  amount: { type: Number, required: true },
});

const OrderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
    },
    code: {
      type: String,
      unique: true,
      sparse: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
    },
    serviceType: {
      type: String,
      enum: ['wash-fold', 'wash-iron', 'iron-only'],
    },
    orderType: {
      type: String,
      enum: ['pickup-delivery', 'walk-in'],
    },
    items: [OrderItemSchema],
    pickupAddress: AddressSchema,
    deliveryAddress: AddressSchema,
    pickupDate: Date,
    deliveryDate: Date,
    scheduledPickupTime: String,
    specialInstructions: String,
    status: {
      type: String,
      enum: [
        'draft',
        'pending',
        'confirmed',
        'in_progress',
        'picked-up',
        'washing',
        'ironing',
        'ready',
        'out-for-delivery',
        'delivered',
        'completed',
        'cancelled',
      ],
      default: 'pending',
    },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'paid', 'partial', 'refunded'],
      default: 'unpaid',
    },
    lastUpdatedById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    pickupMethod: {
      type: String,
      enum: ['drop_off', 'pickup', 'delivery'],
    },
    pickupWindowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PickupWindow',
    },
    deliveryZoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DeliveryZone',
    },
    deliveryFee: { type: Number, default: 0 },
    rush: { type: Boolean, default: false },
    serviceLevel: {
      type: String,
      enum: ['standard', 'express', 'premium'],
      default: 'standard',
    },
    serviceLevelStartedAt: Date,
    serviceLevelDueAt: Date,
    priorityHandling: { type: Boolean, default: false },
    stainRemoval: { type: Boolean, default: false },
    total: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    loyaltyPointsEarned: { type: Number, default: 0 },
    loyaltyPointsRedeemed: { type: Number, default: 0 },
    loyaltyDiscountAmount: { type: Number, default: 0 },
    usedSubscription: { type: Boolean, default: false },
    promoCodeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PromoCode',
    },
    statusHistory: [StatusHistorySchema],
    assignedStaff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    pricing: {
      type: PricingSchema,
    },
    payment: {
      type: PaymentSchema,
    },
    notes: String,
    qrCode: String,
  },
  {
    timestamps: true,
  }
);

// Generate order number before saving
OrderSchema.pre('save', async function (next) {
  if (!this.isNew) {
    return next();
  }

  const count = await mongoose.model('Order').countDocuments();
  this.orderNumber = `RLX${Date.now()}${String(count + 1).padStart(4, '0')}`;

  // Add initial status to history
  this.statusHistory.push({
    status: this.status,
    timestamp: new Date(),
    updatedBy: this.customer,
  });

  next();
});

// Add indexes for better query performance
OrderSchema.index({ customer: 1, createdAt: -1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ 'payment.status': 1 });

module.exports = mongoose.model('Order', OrderSchema);
