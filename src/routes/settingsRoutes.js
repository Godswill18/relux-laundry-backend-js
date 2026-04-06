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
  getStageDurationSettings,
  updateStageDurationSettings,
} = require('../controllers/settingsController.js');

const { protect, authorize } = require('../middleware/auth.js');

// Service level configs (readable by any authenticated user)
router.get('/service-levels', protect, getServiceLevelConfigs);
router.post('/service-levels', protect, authorize('admin'), createServiceLevelConfig);
router.put('/service-levels/:id', protect, authorize('admin'), updateServiceLevelConfig);

// Stage duration settings (readable by staff/admin for countdown logic)
router.get('/stage-durations', protect, authorize('admin', 'manager', 'staff', 'receptionist'), getStageDurationSettings);
router.put('/stage-durations', protect, authorize('admin'), updateStageDurationSettings);

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
