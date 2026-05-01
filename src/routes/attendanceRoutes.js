const express = require('express');
const router = express.Router();
const {
  clockIn,
  clockOut,
  getMyAttendance,
  getAttendance,
  getAttendanceByUser,
  updateAttendance,
  getMonthlyHoursSummary,
} = require('../controllers/attendanceController.js');

const { exportWorkHoursExcel, exportWorkHoursPDF } = require('../controllers/exportController.js');
const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);

// Self-service
router.post('/clock-in', clockIn);
router.put('/clock-out', clockOut);
router.get('/me', getMyAttendance);

// Admin
router.get('/monthly-hours',        authorize('admin', 'manager'), getMonthlyHoursSummary);
router.get('/export/work-hours/excel', authorize('admin', 'manager'), exportWorkHoursExcel);
router.get('/export/work-hours/pdf',   authorize('admin', 'manager'), exportWorkHoursPDF);
router.get('/', authorize('admin', 'manager'), getAttendance);
router.get('/user/:userId', authorize('admin', 'manager'), getAttendanceByUser);
router.put('/:id', authorize('admin', 'manager'), updateAttendance);

module.exports = router;
