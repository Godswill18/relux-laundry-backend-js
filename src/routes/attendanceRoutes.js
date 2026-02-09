const express = require('express');
const router = express.Router();
const {
  clockIn,
  clockOut,
  getMyAttendance,
  getAttendance,
  getAttendanceByUser,
  updateAttendance,
} = require('../controllers/attendanceController.js');

const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);

// Self-service
router.post('/clock-in', clockIn);
router.put('/clock-out', clockOut);
router.get('/me', getMyAttendance);

// Admin
router.get('/', authorize('admin', 'manager'), getAttendance);
router.get('/user/:userId', authorize('admin', 'manager'), getAttendanceByUser);
router.put('/:id', authorize('admin', 'manager'), updateAttendance);

module.exports = router;
