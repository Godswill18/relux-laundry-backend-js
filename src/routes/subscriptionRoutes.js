const express = require('express');
const router = express.Router();
const {
  getPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  getMySubscription,
  subscribe,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  getSubscriptions,
  getUsage,
} = require('../controllers/subscriptionController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Plan routes (must be before /:id)
router.get('/plans', protect, getPlans);
router.post('/plans', protect, authorize('admin'), createPlan);
router.get('/plans/:id', protect, getPlan);
router.put('/plans/:id', protect, authorize('admin'), updatePlan);
router.delete('/plans/:id', protect, authorize('admin'), deletePlan);

// Customer self-service
router.get('/me', protect, getMySubscription);
router.post('/', protect, subscribe);

// Admin list
router.get('/', protect, authorize('admin', 'manager'), getSubscriptions);

// Subscription actions
router.put('/:id/cancel', protect, cancelSubscription);
router.put('/:id/pause', protect, pauseSubscription);
router.put('/:id/resume', protect, resumeSubscription);
router.get('/:id/usage', protect, getUsage);

module.exports = router;
