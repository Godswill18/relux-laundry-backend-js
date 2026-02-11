const express = require('express');
const router = express.Router();
const {
  getCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  getMyProfile,
  updateMyProfile,
  suspendCustomer,
  activateCustomer,
} = require('../controllers/customerController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Customer self-service routes
router.get('/me', protect, getMyProfile);
router.put('/me', protect, updateMyProfile);

// Admin/staff routes
router.use(protect);
router.use(authorize('admin', 'manager', 'staff'));

router.route('/').get(getCustomers).post(createCustomer);

router.route('/:id').get(getCustomer).put(authorize('admin', 'manager'), updateCustomer);

router.put('/:id/suspend', authorize('admin', 'manager'), suspendCustomer);
router.put('/:id/activate', authorize('admin', 'manager'), activateCustomer);

module.exports = router;
