const express = require('express');
const router = express.Router();
const {
  getPeriods,
  getPeriod,
  createPeriod,
  finalizePeriod,
  markPeriodPaid,
  getEntries,
  generateEntries,
  updateEntry,
  getMyPayslips,
  getPayslip,
  generatePayslip,
} = require('../controllers/payrollController.js');

const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);

// My payslips (must be before /:id routes)
router.get('/payslips/me', getMyPayslips);
router.get('/payslips/:id', getPayslip);

// Period routes
router.get('/periods', authorize('admin', 'manager'), getPeriods);
router.post('/periods', authorize('admin'), createPeriod);
router.get('/periods/:id', authorize('admin', 'manager'), getPeriod);
router.put('/periods/:id/finalize', authorize('admin'), finalizePeriod);
router.put('/periods/:id/paid', authorize('admin'), markPeriodPaid);

// Entry routes
router.get('/periods/:periodId/entries', authorize('admin', 'manager'), getEntries);
router.post('/periods/:periodId/generate', authorize('admin'), generateEntries);
router.put('/entries/:id', authorize('admin'), updateEntry);
router.post('/entries/:entryId/payslip', authorize('admin'), generatePayslip);

module.exports = router;
