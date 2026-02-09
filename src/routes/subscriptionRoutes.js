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

const { dualProtect, protect, authorize } = require('../middleware/auth.js');

// Plan routes (must be before /:id)
router.get('/plans', dualProtect, getPlans);
router.post('/plans', protect, authorize('admin'), createPlan);
router.get('/plans/:id', dualProtect, getPlan);
router.put('/plans/:id', protect, authorize('admin'), updatePlan);
router.delete('/plans/:id', protect, authorize('admin'), deletePlan);

// Customer self-service
router.get('/me', dualProtect, getMySubscription);
router.post('/', dualProtect, subscribe);

// Admin list
router.get('/', protect, authorize('admin', 'manager'), getSubscriptions);

// Subscription actions
router.put('/:id/cancel', dualProtect, cancelSubscription);
router.put('/:id/pause', dualProtect, pauseSubscription);
router.put('/:id/resume', dualProtect, resumeSubscription);
router.get('/:id/usage', dualProtect, getUsage);

module.exports = router;
