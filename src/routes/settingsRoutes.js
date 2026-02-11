const express = require('express');
const router = express.Router();
const {
  getPaymentSettings,
  updatePaymentSettings,
  getNotificationSettings,
  updateNotificationSettings,
  getReferralSettings,
  updateReferralSettings,
  getLoyaltySettings,
  updateLoyaltySettings,
  getServiceLevelConfigs,
  createServiceLevelConfig,
  updateServiceLevelConfig,
} = require('../controllers/settingsController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Service level configs (readable by any authenticated user)
router.get('/service-levels', protect, getServiceLevelConfigs);
router.post('/service-levels', protect, authorize('admin'), createServiceLevelConfig);
router.put('/service-levels/:id', protect, authorize('admin'), updateServiceLevelConfig);

// Admin-only settings
router.use(protect);
router.use(authorize('admin'));

router.get('/payment', getPaymentSettings);
router.put('/payment', updatePaymentSettings);

router.get('/notification', getNotificationSettings);
router.put('/notification', updateNotificationSettings);

router.get('/referral', getReferralSettings);
router.put('/referral', updateReferralSettings);

router.get('/loyalty', getLoyaltySettings);
router.put('/loyalty', updateLoyaltySettings);

module.exports = router;
