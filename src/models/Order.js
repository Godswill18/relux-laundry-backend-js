const mongoose = require('mongoose');
const { ORDER_STATUSES } = require('../utils/orderStatus.js');
// Loaded here, not looked up by name: nothing else requires Counter.js, so
// mongoose.model('Counter') threw "Schema hasn't been registered for model
// Counter" and every new order — online and walk-in — failed to save.
const Counter = require('./Counter.js');

// Snapshot of a selected add-on at the time of order creation.
// Stored inline so future edits to the Addon doc don't change past orders.
const OrderAddonSchema = new mongoose.Schema({
  addonId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Addon' },
  name:            { type: String },   // snapshot
  type:            { type: String },   // 'fixed' | 'percentage' snapshot
  value:           { type: Number },   // snapshot value (₦ or %)
  calculatedAmount:{ type: Number, default: 0 }, // resolved ₦ amount for this order
}, { _id: false });

// An add-on applied to SOME of the garments on one order line — e.g. starch on
// 2 of 5 shirts. quantity can never exceed the line's quantity. Prices are
// resolved on the server and snapshotted, like everything else on the order.
const OrderItemAddonSchema = new mongoose.Schema({
  addonId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Addon' },
  name:      { type: String },            // snapshot
  type:      { type: String },            // 'fixed' | 'percentage' snapshot
  value:     { type: Number },            // snapshot of the configured value
  quantity:  { type: Number, min: 1 },    // garments on this line that get it
  unitPrice: { type: Number, default: 0 },// resolved ₦ per garment
  total:     { type: Number, default: 0 },// quantity × unitPrice
}, { _id: false });

// One order line: a garment type, a quantity and ONE primary service, plus any
// add-ons. The same garment can appear on several lines with different services
// (2 shirts wash-only, 3 shirts wash & iron).
//
// Garment tracking (orders with itemTracking = true):
//   quantity           garments ordered on this line
//   readyQuantity      garments finished so far — cumulative, INCLUDES any that
//                      have since been collected
//   collectedQuantity  garments handed back so far, across all collections
// so always  0 ≤ collectedQuantity ≤ readyQuantity ≤ quantity, and
//   still processing       = quantity − readyQuantity
//   ready, awaiting pickup = readyQuantity − collectedQuantity
//   outstanding            = quantity − collectedQuantity
// Both counters are deliberately left without a default: an order written
// before tracking existed must read as "not recorded", never as "0 collected".
const OrderItemSchema = new mongoose.Schema({
  itemType: { type: String, required: true },
  // Per-item service type. Older rows hold a care type (wash-fold, wash-iron…)
  // or 'laundry'; lines priced from the catalogue hold the service name.
  serviceType: { type: String },
  // Human-readable service name for display grouping (e.g. "Washing", "Dry Cleaning")
  serviceName: { type: String },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, default: 0 },
  // Service charge for the line: unitPrice × quantity. Add-ons are NOT included
  // here (they are in addonsTotal), so every existing reader of `total` and the
  // order subtotal keep their meaning.
  total: { type: Number, default: 0 },
  addons: { type: [OrderItemAddonSchema], default: [] },
  addonsTotal: { type: Number },
  lineTotal: { type: Number },            // total + addonsTotal
  // 'catalogue' = priced from the service price list on the server
  // 'manual'    = a counter item that is not in the price list, priced by staff
  priceSource: { type: String, enum: ['catalogue', 'manual'] },
  readyQuantity: { type: Number, min: 0 },
  collectedQuantity: { type: Number, min: 0 },
  notes: { type: String, maxlength: 500 },
  careType: String,
  categoryId: String,
  categoryName: String,
  description: String,
  condition: String,
});

// One recorded step in a line's life: marked ready, a correction, a collection.
// Kept on the order so the timeline can be shown without a join; collections
// additionally get their own OrderCollection record.
const FulfilmentEventSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['tracking_started', 'ready', 'ready_undone', 'collected'],
    required: true,
  },
  items: [{
    _id: false,
    itemId: { type: mongoose.Schema.Types.ObjectId },
    itemType: String,
    serviceName: String,
    quantity: Number,
  }],
  quantity: { type: Number, default: 0 },
  collectionId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderCollection' },
  // How the event was triggered: an item-level action, a whole-order status
  // change ('ready', 'delivered', 'completed'), a delivery scan, or a migration.
  source: { type: String, enum: ['items', 'status_update', 'delivery_scan', 'migration'], default: 'items' },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  byRole: String,
  notes: String,
  at: { type: Date, default: Date.now },
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
  actorRole: {
    type: String,
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
  // The share of addOnsFee that comes from per-garment line add-ons (already
  // included in addOnsFee — shown for the breakdown only, never added again).
  itemAddOnsFee: { type: Number },
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
    idempotencyKey: {
      type: String,
      unique: true,
      sparse: true,
      select: false,
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
      // Optional. Captured at the counter so the customer can later verify
      // ownership by email and activate a portal account.
      email: String,
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
      // 'developer' bypasses authorize() (see auth.js) and can create orders
      // like staff/admin, but was missing here — every order a developer
      // account created failed schema validation on this field alone.
      enum: ['admin', 'manager', 'staff', 'receptionist', 'developer', 'customer'],
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
      // Canonical statuses only (utils/orderStatus.js). 'draft' is retained
      // solely so any pre-existing draft rows stay valid; nothing creates it.
      enum: [...ORDER_STATUSES, 'draft'],
      default: 'pending',
    },
    // Delivery logistics — metadata, deliberately NOT part of `status`.
    deliveryStatus: { type: String, enum: ['out_for_delivery', 'delivered'] },
    dispatchedAt: Date,
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
    // Dynamic add-ons: snapshots of selected add-ons at time of order creation
    addons: { type: [OrderAddonSchema], default: [] },
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
    // Loyalty tier benefit snapshot — locked at checkout, unaffected by future tier changes
    loyaltyTierSnapshot: {
      tierId:          { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyTier' },
      tierName:        String,
      discountPercent: Number,
      discountAmount:  Number,
      freeDelivery:    Boolean,
      freePickup:      Boolean,
      priorityHandling: Boolean,
      multiplierPercent: Number,
    },
    // ── Service-level SLA (utils/orderSla.js) ───────────────────────────────
    // Server time of the move to confirmed: the one start of the SLA clock.
    // Absent on legacy orders and never back-filled.
    confirmedAt: { type: Date },
    // Snapshot of the service level's processing time at confirmation, so a
    // later settings change never moves a promise already made.
    slaServiceLevelId: { type: mongoose.Schema.Types.ObjectId, ref: 'ServiceLevelConfig' },
    slaServiceLevelName: { type: String },
    slaHours: { type: Number },
    // Estimated completion = confirmedAt + slaHours. The one deadline every UI shows.
    slaDueAt: { type: Date },
    // Copies of slaDueAt / its "due soon" point, present only while the order
    // is still processing. Drive the Overdue / Due soon filters and alerts.
    slaActiveDueAt: { type: Date },
    slaDueSoonAt: { type: Date },
    // When the whole order was ready. Preserved for on-time / late reporting.
    readyAt: { type: Date },
    // One alert per milestone per order, so staff are not spammed.
    slaNotified: { dueSoonAt: Date, overdueAt: Date },
    // DEPRECATED — the old per-stage countdown (StageDurationSetting). No longer
    // written; kept so existing documents still read cleanly.
    stageDeadlineAt: { type: Date },
    stageDurationMinutes: { type: Number },
    // When the pickup and delivery legs actually happened. Both were already being
    // assigned by updateOrderStatus and scanPickup but were never declared, so
    // Mongoose strict mode discarded them on every save.
    actualPickupDate: { type: Date },
    actualDeliveryDate: { type: Date },

    // ── Garment tracking ────────────────────────────────────────────────────
    // true when readiness and collection are recorded per line (see
    // OrderItemSchema). Orders written before this existed have no value and
    // are read from their status instead — nothing is inferred into them.
    itemTracking: { type: Boolean },
    // Denormalised from the lines on every change, so lists, filters and
    // reports never have to unwind items. Sum of item quantities, not rows.
    totalGarments: { type: Number },
    readyGarments: { type: Number },
    collectedGarments: { type: Number },
    // Where the garments are, independent of `status` (the processing
    // workflow) and of paymentStatus (the money).
    fulfilmentStatus: {
      type: String,
      enum: ['processing', 'partially_ready', 'ready', 'partially_collected', 'collected'],
    },
    // Bumped on every change to the lines or their counters. Saves that touch
    // them are conditional on the value they read, so two people releasing the
    // same garments at once cannot both succeed. No default on purpose — see
    // versionFilter() in utils/orderFulfilment.js.
    fulfilmentVersion: { type: Number },
    collectionCount: { type: Number },
    fulfilmentHistory: { type: [FulfilmentEventSchema], default: undefined },
    // When the customer was last told about readiness, so a notification is
    // sent once per milestone rather than on every garment.
    readyNotifications: {
      partialAt: Date,
      fullAt: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Guard the garment counters on every document save. Atomic updates in
// utils/orderFulfilment.js check the same rules before writing.
OrderSchema.pre('validate', function (next) {
  if (!this.itemTracking || !Array.isArray(this.items)) return next();
  for (const item of this.items) {
    const qty = item.quantity || 0;
    const ready = item.readyQuantity || 0;
    const collected = item.collectedQuantity || 0;
    if (ready > qty || collected > ready) {
      // Surfaces as a normal ValidationError (HTTP 400), never a partial write.
      this.invalidate(
        'items',
        `Garment counts for "${item.itemType}" are inconsistent (ordered ${qty}, ready ${ready}, collected ${collected})`
      );
      break;
    }
  }
  next();
});

// Allocate the next order sequence for a month, atomically.
//
// The first allocation in any month seeds the counter from the highest number
// already issued, so switching an existing production month over to the counter
// never reissues a number that is already printed on a ticket.
async function nextOrderSequence(monthYear) {
  const key = `order:${monthYear}`;

  // Fast path — counter already established for this month
  const existing = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true }
  );
  if (existing) return existing.seq;

  // First allocation this month: find the highest sequence already in use.
  // Compared numerically, not as a string, so it stays correct past 999.
  const prefix = `RLX-${monthYear}-`;
  let lastSeq = 0;
  try {
    const [agg] = await mongoose.model('Order').aggregate([
      { $match: { orderNumber: { $regex: `^${prefix}` } } },
      {
        $project: {
          seq: {
            $convert: {
              input: { $substrBytes: ['$orderNumber', prefix.length, 12] },
              to: 'int',
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      { $group: { _id: null, max: { $max: '$seq' } } },
    ]);
    lastSeq = agg?.max || 0;
  } catch (_) {
    // Aggregation unavailable — fall through with 0; the unique index plus the
    // retry in createOrder still prevent a collision from being persisted.
  }

  // $max is idempotent, so two workers seeding at once converge on the same floor
  await Counter.updateOne({ _id: key }, { $max: { seq: lastSeq } }, { upsert: true });

  const counter = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

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

  const seq = await nextOrderSequence(monthYear);
  this.orderNumber = `${prefix}${String(seq).padStart(3, '0')}`;

  // Generate a short 6-character alphanumeric code for customer reference
  if (!this.code) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    this.code = code;
  }

  // Add initial status to history.
  // Staff creator always takes priority (walk-in orders); fall back to customer for online orders.
  // actorRole recorded so admin UI can distinguish staff actions from customer self-service.
  this.statusHistory.push({
    status: this.status,
    timestamp: new Date(),
    updatedBy: this.createdByStaff || this.customer,
    actorRole: this.createdByRole || 'customer',
  });

  next();
});

// ── Service SLA ──────────────────────────────────────────────────────────
// Remember the status the document was loaded with: a move out of pending /
// cancelled is what starts the clock.
OrderSchema.post('init', function () {
  this.$locals.prevStatus = this.status;
});

OrderSchema.pre('save', async function (next) {
  try {
    const { applySla } = require('../utils/orderSla.js');
    this.$locals.slaChanges = await applySla(this);
    next();
  } catch (err) {
    next(err);
  }
});

OrderSchema.post('save', function () {
  const changes = this.$locals.slaChanges;
  this.$locals.prevStatus = this.status;
  if (!changes || !changes.length) return;
  this.$locals.slaChanges = [];
  const { logAudit } = require('../utils/auditLogger.js');
  for (const c of changes) {
    logAudit({
      actorUserId: c.actorId || this.lastUpdatedById,
      action: c.action,
      targetType: 'Order',
      targetId: String(this._id),
      before: c.before,
      after: c.after,
      metadata: { orderNumber: this.orderNumber, reason: c.reason },
    });
  }
});

// Add indexes for better query performance
OrderSchema.index({ customer: 1, createdAt: -1 });
OrderSchema.index({ status: 1 });
OrderSchema.index({ 'payment.status': 1 });
// Every dashboard and report aggregate matches on the top-level paymentStatus
// (see paidOrderMatch()), not on payment.status — that one was the only indexed
// of the pair, so revenue queries were collection scans.
OrderSchema.index({ paymentStatus: 1, status: 1 });
// Reporting and export windows are all createdAt ranges, usually narrowed by status.
OrderSchema.index({ createdAt: -1 });
// Staff dashboard tabs: assigned/unassigned pools and the walk-in list.
OrderSchema.index({ assignedStaff: 1, status: 1 });
OrderSchema.index({ orderSource: 1, status: 1 });
// Walk-in orders are surfaced to a matching customer account by phone.
OrderSchema.index({ 'walkInCustomer.phone': 1 });
// Order history is now read through the customer record.
OrderSchema.index({ customerId: 1, createdAt: -1 });
// Counter filters: partially ready / ready for collection / partially collected.
OrderSchema.index({ fulfilmentStatus: 1, createdAt: -1 });
// SLA list filters (Overdue / Due soon) and the alert monitor. Sparse: legacy
// and finished orders carry no value and stay out of the index.
OrderSchema.index({ slaActiveDueAt: 1 }, { sparse: true });
OrderSchema.index({ slaDueSoonAt: 1 }, { sparse: true });
// SLA performance reports window on when processing finished.
OrderSchema.index({ readyAt: 1 }, { sparse: true });

// Safety net while the status migration rolls out: a not-yet-migrated row is
// still SERIALISED with its canonical status, so no client ever receives a
// retired value. The migration (utils/migrations/canonicalOrderStatus.js) is
// what actually changes the stored data.
const { normalizeOrderStatus } = require('../utils/orderStatus.js');
const canonicalise = (_doc, ret) => {
  const n = normalizeOrderStatus(ret.status);
  if (n.status && n.status !== ret.status) ret.status = n.status;
  return ret;
};
OrderSchema.set('toJSON', { transform: canonicalise });
OrderSchema.set('toObject', { transform: canonicalise });

module.exports = mongoose.model('Order', OrderSchema);
