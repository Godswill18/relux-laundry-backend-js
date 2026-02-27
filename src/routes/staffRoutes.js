const express = require('express');
const router = express.Router();
const {
  getStaff,
  createStaff,
  updateStaff,
  deleteStaff,
  getCompensation,
  setCompensation,
  getShifts,
  getShift,
  createShift,
  updateShift,
  deleteShift,
  getMyShifts,
  emergencyActivate,
  emergencyDeactivate,
  getMyProfile,
  updateMyProfile,
  updateMyBank,
} = require('../controllers/staffController.js');

const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);

// Staff CRUD (static routes first)
router.get('/', authorize('admin', 'manager'), getStaff);
router.post('/', authorize('admin', 'manager'), createStaff);

// Self-service profile (must be before /:id to avoid match conflict)
router.get('/me', getMyProfile);
router.patch('/me/bank', updateMyBank);
router.patch('/me', updateMyProfile);

// My shifts (must be before /shifts/:id)
router.get('/shifts/me', getMyShifts);

// Shift CRUD
router.get('/shifts', authorize('admin', 'manager', 'staff'), getShifts);
router.post('/shifts', authorize('admin', 'manager'), createShift);

// Emergency activate/deactivate (must be before /shifts/:id to avoid conflict)
router.put('/shifts/:id/activate', authorize('admin', 'manager'), emergencyActivate);
router.put('/shifts/:id/deactivate', authorize('admin', 'manager'), emergencyDeactivate);

router.get('/shifts/:id', authorize('admin', 'manager', 'staff'), getShift);
router.put('/shifts/:id', authorize('admin', 'manager'), updateShift);
router.delete('/shifts/:id', authorize('admin', 'manager'), deleteShift);

// Staff member update/delete (parameterized, must come after static routes)
router.patch('/:id', authorize('admin', 'manager'), updateStaff);
router.delete('/:id', authorize('admin'), deleteStaff);

// Compensation
router.get('/:userId/compensation', authorize('admin', 'manager'), getCompensation);
router.put('/:userId/compensation', authorize('admin', 'manager'), setCompensation);

module.exports = router;
