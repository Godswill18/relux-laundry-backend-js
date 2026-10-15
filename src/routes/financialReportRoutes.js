const express = require('express');
const { protect } = require('../middleware/auth.js');
const c = require('../controllers/financialReportController.js');

const router = express.Router();

// Developer ("Superadmin") only — every route, including exports.
router.use(protect, c.requireFinancialAccess);

router.get('/summary', c.summary);
router.get('/paid-orders', c.paidOrders);
router.get('/outstanding-orders', c.outstandingOrders);
router.get('/revenue-trend', c.trend);
router.get('/anomalies', c.anomalies);
router.get('/export', c.exportReport);

module.exports = router;
