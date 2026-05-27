const AuditLog = require('../models/AuditLog.js');
const logger = require('./logger.js');

const logAudit = async ({ actorUserId, action, targetType, targetId, before, after, metadata }) => {
  try {
    await AuditLog.create({ actorUserId, action, targetType, targetId, before, after, metadata });
  } catch (err) {
    // Audit logging should not break the main flow
    logger.error({ message: 'Audit log error', error: err.message });
  }
};

module.exports = { logAudit };
