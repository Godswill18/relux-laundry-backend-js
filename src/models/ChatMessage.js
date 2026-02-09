const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema(
  {
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatThread', required: true },
    senderType: { type: String, enum: ['customer', 'staff'], required: true },
    senderCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    body: { type: String, required: true },
  },
  { timestamps: true }
);

ChatMessageSchema.index({ threadId: 1 });
ChatMessageSchema.index({ senderType: 1 });
ChatMessageSchema.index({ senderCustomerId: 1 });
ChatMessageSchema.index({ senderUserId: 1 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
