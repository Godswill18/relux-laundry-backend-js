const express = require('express');
const router = express.Router();
const {
  getCompensation,
  setCompensation,
  getShifts,
  getShift,
  createShift,
  updateShift,
  deleteShift,
  getMyShifts,
} = require('../controllers/staffController.js');

const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);

// My shifts (must be before /:id)
router.get('/shifts/me', getMyShifts);

// Shift CRUD
router.get('/shifts', authorize('admin', 'manager', 'staff'), getShifts);
router.post('/shifts', authorize('admin', 'manager'), createShift);
router.get('/shifts/:id', authorize('admin', 'manager', 'staff'), getShift);
router.put('/shifts/:id', authorize('admin', 'manager'), updateShift);
router.delete('/shifts/:id', authorize('admin', 'manager'), deleteShift);

// Compensation
router.get('/:userId/compensation', authorize('admin', 'manager'), getCompensation);
router.put('/:userId/compensation', authorize('admin', 'manager'), setCompensation);

module.exports = router;
