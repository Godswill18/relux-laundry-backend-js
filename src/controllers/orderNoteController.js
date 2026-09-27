// ─── Order Notes — internal staff handover log ──────────────────────────────
// See models/OrderNote.js. Every route here is mounted staff-only (see
// routes/orderRoutes.js); no customer-scoped request ever reaches this file.

const mongoose = require('mongoose');
const Order = require('../models/Order.js');
const OrderNote = require('../models/OrderNote.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const ERROR_CODES = require('../utils/errorCodes.js');
const { logAudit } = require('../utils/auditLogger.js');

const MAX_COMMENT_LENGTH = 2000;
const NOTE_TYPES = ['general', 'customer_instruction', 'laundry_issue', 'processing_update', 'collection_note', 'quality_issue'];
// Deciding who may edit/delete someone else's note, or delete at all, is not
// "can this role touch orders" — it's a narrower question, so it is not tied
// to the authorize() list on the route (that only gets a request in the door).
const CAN_MANAGE_OTHERS_NOTES = ['admin', 'manager', 'developer'];

const invalid = (message) => new AppError(message, 400, ERROR_CODES.VALIDATION_ERROR);

function cleanComment(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) throw invalid('Note cannot be empty');
  if (s.length > MAX_COMMENT_LENGTH) throw invalid(`Note is too long (max ${MAX_COMMENT_LENGTH} characters)`);
  return s;
}

// Present a note the same way everywhere: author name/role resolved via the
// populate below, never re-derived per endpoint.
function serializeNote(note) {
  const obj = note.toObject ? note.toObject() : note;
  return {
    _id: obj._id,
    orderId: obj.orderId,
    staffId: obj.staffId,
    authorRole: obj.authorRole,
    authorStaffRole: obj.authorStaffRole,
    itemId: obj.itemId,
    comment: obj.comment,
    noteType: obj.noteType,
    isImportant: obj.isImportant,
    edited: !!obj.editedAt,
    editedAt: obj.editedAt,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
}

async function loadOrderOr404(orderId) {
  if (!mongoose.isValidObjectId(orderId)) throw new AppError('Order not found', 404);
  const order = await Order.findById(orderId).select('_id orderNumber items').lean();
  if (!order) throw new AppError('Order not found', 404);
  return order;
}

// @desc    List an order's internal staff notes (newest first)
// @route   GET /api/v1/orders/:id/notes
// @access  Private (staff, receptionist, manager, admin, developer)
exports.getOrderNotes = asyncHandler(async (req, res, next) => {
  const order = await loadOrderOr404(req.params.id);

  const notes = await OrderNote.find({ orderId: order._id, deletedAt: null })
    .sort('-createdAt')
    .populate('staffId', 'name role staffRole')
    .lean();

  res.status(200).json({
    success: true,
    message: 'Notes fetched successfully',
    data: {
      notes: notes.map(serializeNote),
      total: notes.length,
      important: notes.filter((n) => n.isImportant).length,
    },
  });
});

// @desc    Add an internal staff note to an order
// @route   POST /api/v1/orders/:id/notes
// @access  Private (staff, receptionist, manager, admin, developer)
exports.createOrderNote = asyncHandler(async (req, res, next) => {
  const order = await loadOrderOr404(req.params.id);

  const comment = cleanComment(req.body.comment);

  let noteType = req.body.noteType || 'general';
  if (!NOTE_TYPES.includes(noteType)) {
    return next(invalid(`Note type must be one of: ${NOTE_TYPES.join(', ')}`));
  }

  let itemId;
  if (req.body.itemId) {
    if (!mongoose.isValidObjectId(req.body.itemId)) return next(invalid('Unknown item'));
    const onOrder = (order.items || []).some((i) => String(i._id) === String(req.body.itemId));
    if (!onOrder) return next(invalid('That item is not on this order'));
    itemId = req.body.itemId;
  }

  const note = await OrderNote.create({
    orderId: order._id,
    staffId: req.user.id,
    authorRole: req.user.role,
    authorStaffRole: req.user.staffRole || undefined,
    itemId,
    comment,
    noteType,
    isImportant: req.body.isImportant === true,
  });
  await note.populate('staffId', 'name role staffRole');

  await logAudit({
    actorUserId: req.user.id,
    action: 'ORDER_NOTE_CREATED',
    targetType: 'Order',
    targetId: order._id.toString(),
    after: { comment, noteType, isImportant: note.isImportant, itemId },
    metadata: { orderNumber: order.orderNumber, noteId: note._id.toString() },
  });

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:note-added', {
      orderId: order._id,
      note: serializeNote(note),
    });
  }

  res.status(201).json({
    success: true,
    message: 'Note added',
    data: { note: serializeNote(note) },
  });
});

// @desc    Edit a note's text, or mark it important/unimportant
// @route   PATCH /api/v1/orders/:id/notes/:noteId
// @access  Private — the note's own author, or admin/manager/developer
exports.updateOrderNote = asyncHandler(async (req, res, next) => {
  const order = await loadOrderOr404(req.params.id);
  if (!mongoose.isValidObjectId(req.params.noteId)) return next(new AppError('Note not found', 404));

  const note = await OrderNote.findOne({ _id: req.params.noteId, orderId: order._id, deletedAt: null });
  if (!note) return next(new AppError('Note not found', 404));

  // Rewriting someone's words (the comment, or reclassifying it) is
  // author-or-manager only. Flagging importance is not — any authorized
  // staff who can see the note may raise it as important for whoever reads
  // the order next, the same way anyone can notice something is urgent.
  const changingText = req.body.comment !== undefined || req.body.noteType !== undefined;
  const isOwnNote = String(note.staffId) === String(req.user.id);
  if (changingText && !isOwnNote && !CAN_MANAGE_OTHERS_NOTES.includes(req.user.role)) {
    return next(new AppError("Only the note's author, or a manager or admin, can edit its text", 403));
  }

  const before = { comment: note.comment, isImportant: note.isImportant };
  let commentChanged = false;
  let importantChanged = false;

  if (req.body.comment !== undefined) {
    const comment = cleanComment(req.body.comment);
    if (comment !== note.comment) {
      note.comment = comment;
      note.editedAt = new Date();
      commentChanged = true;
    }
  }
  if (req.body.isImportant !== undefined) {
    const wantsImportant = req.body.isImportant === true;
    if (wantsImportant !== note.isImportant) {
      note.isImportant = wantsImportant;
      importantChanged = true;
    }
  }
  if (req.body.noteType !== undefined) {
    if (!NOTE_TYPES.includes(req.body.noteType)) return next(invalid(`Note type must be one of: ${NOTE_TYPES.join(', ')}`));
    note.noteType = req.body.noteType;
  }

  if (!commentChanged && !importantChanged && req.body.noteType === undefined) {
    // Nothing actually changed — respond, but don't write a no-op audit entry
    await note.populate('staffId', 'name role staffRole');
    return res.status(200).json({ success: true, message: 'Note unchanged', data: { note: serializeNote(note) } });
  }

  await note.save();
  await note.populate('staffId', 'name role staffRole');

  if (commentChanged) {
    await logAudit({
      actorUserId: req.user.id,
      action: 'ORDER_NOTE_UPDATED',
      targetType: 'Order',
      targetId: order._id.toString(),
      before: { comment: before.comment },
      after: { comment: note.comment },
      metadata: { orderNumber: order.orderNumber, noteId: note._id.toString() },
    });
  }
  if (importantChanged) {
    await logAudit({
      actorUserId: req.user.id,
      action: 'ORDER_NOTE_MARKED_IMPORTANT',
      targetType: 'Order',
      targetId: order._id.toString(),
      before: { isImportant: before.isImportant },
      after: { isImportant: note.isImportant },
      metadata: { orderNumber: order.orderNumber, noteId: note._id.toString() },
    });
  }

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:note-updated', {
      orderId: order._id,
      note: serializeNote(note),
    });
  }

  res.status(200).json({
    success: true,
    message: 'Note updated',
    data: { note: serializeNote(note) },
  });
});

// @desc    Soft-delete a note (preserved for audit, hidden from the list)
// @route   DELETE /api/v1/orders/:id/notes/:noteId
// @access  Private (admin, manager, developer)
exports.deleteOrderNote = asyncHandler(async (req, res, next) => {
  const order = await loadOrderOr404(req.params.id);
  if (!mongoose.isValidObjectId(req.params.noteId)) return next(new AppError('Note not found', 404));

  const note = await OrderNote.findOne({ _id: req.params.noteId, orderId: order._id, deletedAt: null });
  if (!note) return next(new AppError('Note not found', 404));

  note.deletedAt = new Date();
  await note.save();

  await logAudit({
    actorUserId: req.user.id,
    action: 'ORDER_NOTE_DELETED',
    targetType: 'Order',
    targetId: order._id.toString(),
    before: { comment: note.comment, isImportant: note.isImportant, noteType: note.noteType },
    metadata: { orderNumber: order.orderNumber, noteId: note._id.toString() },
  });

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:note-deleted', { orderId: order._id, noteId: note._id });
  }

  res.status(200).json({ success: true, message: 'Note removed', data: {} });
});
