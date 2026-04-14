const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema({
  itemType: { type: String, required: true },
  // Per-item service type (e.g. wash-fold, wash-iron, iron-only, dry-clean)
  serviceType: { type: String },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  careType: String,
  categoryId: String,
  categoryName: String,
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

const EditHistorySchema = new mongoose.Schema({
  editedAt: { type: Date, default: Date.now },
  editedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  previousTotal: { type: Number, required: true },
  newTotal: { type: Number, required: true },
  difference: { type: Number, required: true }, // positive = refund, negative = extra owed
  refundIssued: { type: Boolean, default: false },
  refundAmount: { type: Number, default: 0 },
  notes: String,
});

const PricingSchema = new mongoose.Schema({
  subtotal: { type: Number, default: 0 },
  serviceFee: { type: Number, default: 0 },
  pickupFee: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  addOnsFee: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, required: true },
});

const PaymentSchema = new mongoose.Schema({
  method: {
    type: String,
    enum: ['online', 'cash', 'pos', 'wallet', 'card', 'transfer', 'pay-later'],
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
    // 'online' = placed by customer via app; 'offline' = created by staff for walk-in
    orderSource: {
      type: String,
      enum: ['online', 'offline'],
      default: 'online',
    },
    // Walk-in customer info for offline orders (no User account required)
    walkInCustomer: {
      name: String,
      phone: String,
    },
    // Staff member who created this order (populated for offline orders)
    createdByStaff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Role of the creator: 'admin' | 'manager' | 'staff' | 'customer'
    // Used to determine if an order is pickable by other staff
    createdByRole: {
      type: String,
      enum: ['admin', 'manager', 'staff', 'receptionist', 'customer'],
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
    },
    serviceType: {
      type: String,
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
    fragrance: { type: Boolean, default: false },
    // Legacy string field kept for backward compat — use serviceLevelId for new orders
    serviceLevel: {
      type: String,
      default: 'standard',
    },
    // Dynamic service level reference + snapshots (new orders use these)
    serviceLevelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ServiceLevelConfig',
    },
    serviceLevelName: { type: String },         // snapshot — name at time of order creation
    serviceLevelPercentage: { type: Number, default: 0 }, // snapshot — percentage at time of order creation
    serviceLevelStartedAt: Date,
    serviceLevelDueAt: Date,
    priorityHandling: { type: Boolean, default: false },
    stainRemoval: { type: Boolean, default: false },
    total: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    loyaltyPointsEarned: { type: Number, default: 0 },
    loyaltyPointsAwarded: { type: Boolean, default: false },
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
    pickupStaffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    deliveredBy: {
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
    editHistory: [EditHistorySchema],
    // Countdown timer fields — set each time status changes to a timed stage
    stageDeadlineAt: { type: Date },
    stageDurationMinutes: { type: Number },
  },
  {
    timestamps: true,
  }
);

// Generate order number before validation (must run before validate, not save,
// because orderNumber is required and validation runs before pre-save hooks)
OrderSchema.pre('validate', async function (next) {
  if (!this.isNew) {
    return next();
  }

  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const monthYear = `${now.getFullYear()}${month}`;
  const prefix = `RLX-${monthYear}-`;

  // Count orders for this month to get the next sequence number
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthCount = await mongoose.model('Order').countDocuments({
    createdAt: { $gte: monthStart, $lt: monthEnd },
  });
  this.orderNumber = `${prefix}${String(monthCount + 1).padStart(3, '0')}`;

  // Generate a short 6-character alphanumeric code for customer reference
  if (!this.code) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    this.code = code;
  }

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
