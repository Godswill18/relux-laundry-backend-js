const mongoose = require('mongoose');

// ── OrderCollection ───────────────────────────────────────────────────────────
// One handover of garments to the customer. An order can be collected in
// several visits; each visit is its own record and is never edited afterwards,
// so the history of what left the shop, when, and who released it is complete.
//
// The quantities here are also applied to order.items[].collectedQuantity in
// the same transaction (see utils/orderFulfilment.js).
// ─────────────────────────────────────────────────────────────────────────────

const CollectionItemSchema = new mongoose.Schema({
  orderItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
  itemType:    { type: String },   // snapshot — garment name
  serviceName: { type: String },   // snapshot
  quantity:    { type: Number, required: true, min: 1 },
}, { _id: false });

const OrderCollectionSchema = new mongoose.Schema(
  {
    orderId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    orderNumber: { type: String },
    customerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    // 1 for the first collection on an order, 2 for the second…
    sequence:    { type: Number, required: true, min: 1 },
    items:       { type: [CollectionItemSchema], required: true },
    totalQuantity: { type: Number, required: true, min: 1 },
    // counter    — released at the counter through "Collect selected items"
    // delivery   — the order was delivered (status change or delivery scan)
    // status_update — the whole order was marked completed without itemised
    //                 collection; everything outstanding is recorded here
    method: {
      type: String,
      enum: ['counter', 'delivery', 'status_update'],
      default: 'counter',
    },
    // The staff member who released the garments.
    releasedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    releasedByRole: { type: String },
    // Who physically took them, when the counter captures it (the customer, or
    // someone collecting on their behalf).
    collectedBy: {
      name:  { type: String, trim: true, maxlength: 120 },
      phone: { type: String, trim: true, maxlength: 30 },
    },
    // How the person collecting was checked. 'order_code' = the 6-character
    // code on the customer's receipt was entered and matched.
    verification: {
      type: String,
      enum: ['none', 'order_code', 'qr'],
      default: 'none',
    },
    // Payment is a separate concept — recorded for the audit trail only.
    paymentStatusAtCollection: { type: String },
    notes: { type: String, maxlength: 500 },
    // Lets a retried request (double tap, lost response) return the collection
    // it already made instead of releasing the garments twice.
    idempotencyKey: { type: String },
  },
  { timestamps: true }
);

OrderCollectionSchema.index({ orderId: 1, sequence: 1 }, { unique: true });
OrderCollectionSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
OrderCollectionSchema.index({ customerId: 1, createdAt: -1 });
OrderCollectionSchema.index({ releasedBy: 1, createdAt: -1 });

module.exports = mongoose.model('OrderCollection', OrderCollectionSchema);
