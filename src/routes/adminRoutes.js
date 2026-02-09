const express = require('express');
const router = express.Router();
const {
  getDashboardStats,
  getRevenueReport,
  getOrderStats,
} = require('../controllers/adminController.js');

const { protect, authorize } = require('../middleware/auth.js');

// All routes require authentication and admin/manager role
router.use(protect);
router.use(authorize('admin', 'manager'));

router.get('/dashboard', getDashboardStats);
router.get('/reports/revenue', getRevenueReport);
router.get('/stats/orders', getOrderStats);

module.exports = router;
