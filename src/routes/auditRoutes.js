const express = require('express');
const router = express.Router();
const {
  getAuditLogs,
  getAuditLog,
  getAuditLogsByTarget,
} = require('../controllers/auditController.js');

const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);
router.use(authorize('admin'));

router.get('/', getAuditLogs);
router.get('/target/:targetType/:targetId', getAuditLogsByTarget);
router.get('/:id', getAuditLog);

module.exports = router;
