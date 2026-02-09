const AuditLog = require('../models/AuditLog.js');

const logAudit = async ({ actorUserId, action, targetType, targetId, before, after, metadata }) => {
  try {
    await AuditLog.create({ actorUserId, action, targetType, targetId, before, after, metadata });
  } catch (err) {
    // Audit logging should not break the main flow
    console.error('Audit log error:', err.message);
  }
};

module.exports = { logAudit };
