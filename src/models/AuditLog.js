const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema(
  {
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

AuditLogSchema.index({ actorUserId: 1 });
AuditLogSchema.index({ targetType: 1, targetId: 1 });
AuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', AuditLogSchema);
