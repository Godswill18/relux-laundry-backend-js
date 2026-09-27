const mongoose = require('mongoose');

// ─── OrderNote — internal staff handover log ────────────────────────────────
//
// One note per document, never overwritten. Where the old `order.notes`
// string field means "the current note" (and gets replaced on every status
// change), this is a proper history: every note a staff member leaves stays
// on the order for whoever picks it up next.
//
// Internal only. Nothing in this model, its routes, or its controller is
// reachable from a customer-scoped request — see routes/orderRoutes.js and
// controllers/orderNoteController.js. Customers keep their own, separate
// channel (ChatThread/ChatMessage) for anything meant to reach them.
//
// authorRole / authorStaffRole are snapshotted at post time (like every other
// snapshot in this codebase, e.g. OrderItemAddon), so a note still reads
// correctly if the author's role changes or they leave — "Grace — Receptionist"
// stays accurate even if Grace is promoted next month.
const OrderNoteSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorRole: { type: String, required: true },
    authorStaffRole: { type: String },
    // Optional: this note is about one specific order line, not the whole
    // order (e.g. "this shirt has a stain"). References items[]._id on the
    // Order document — items are embedded, so there is nothing to $ref/populate;
    // the frontend matches it against the order it already has loaded.
    itemId: { type: mongoose.Schema.Types.ObjectId },
    comment: { type: String, required: true, trim: true, maxlength: 2000 },
    noteType: {
      type: String,
      enum: ['general', 'customer_instruction', 'laundry_issue', 'processing_update', 'collection_note', 'quality_issue'],
      default: 'general',
    },
    isImportant: { type: Boolean, default: false },
    editedAt: { type: Date },
    // Soft delete: the row stays for audit/history, just stops showing up.
    // Who deleted it is on the AuditLog entry (actorUserId), not duplicated here.
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

// Loading one order's notes, newest first, is the only real access pattern.
OrderNoteSchema.index({ orderId: 1, createdAt: -1 });

module.exports = mongoose.model('OrderNote', OrderNoteSchema);
