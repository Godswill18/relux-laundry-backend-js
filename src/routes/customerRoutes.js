const express = require('express');
const router = express.Router();
const {
  getCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  getMyProfile,
  updateMyProfile,
  suspendCustomer,
  activateCustomer,
  deactivateCustomer,
  reactivateCustomer,
  lookupCustomers,
} = require('../controllers/customerController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Customer self-service routes
router.get('/me', protect, getMyProfile);
router.put('/me', protect, updateMyProfile);

// Counter lookup while creating a walk-in order. Mounted before the
// admin/manager/staff gate below because receptionists create walk-in orders
// too. Must precede '/:id' so 'lookup' is not read as an id.
router.get('/lookup', protect, authorize('admin', 'manager', 'staff', 'receptionist'), lookupCustomers);

// Admin/staff routes
router.use(protect);
router.use(authorize('admin', 'manager', 'staff'));

router.route('/').get(getCustomers).post(createCustomer);

router.route('/:id')
  .get(getCustomer)
  .put(authorize('admin', 'manager'), updateCustomer)
  // DEPRECATED: no longer deletes anything — deactivates instead. Kept only so
  // a stale client cannot reach a hard delete through a missing route.
  .delete(authorize('admin'), deleteCustomer);

// Account status. Admin-only, matching the authority the Delete action had —
// replacing delete with deactivate must not widen who can cut a customer off.
router.patch('/:id/deactivate', authorize('admin'), deactivateCustomer);
router.patch('/:id/reactivate', authorize('admin'), reactivateCustomer);

// DEPRECATED aliases (Customer-profile id). No frontend calls these; they were
// admin+manager and flipped a status nothing enforced. They now share the
// deactivate/reactivate core and its admin-only rule, so there is one
// status system with one authority.
router.put('/:id/suspend', authorize('admin'), suspendCustomer);
router.put('/:id/activate', authorize('admin'), activateCustomer);

module.exports = router;
