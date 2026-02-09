const express = require('express');
const router = express.Router();
const {
  getServices,
  getService,
  createService,
  updateService,
  deleteService,
  getServiceCategories,
  createServiceCategory,
  updateServiceCategory,
  deleteServiceCategory,
} = require('../controllers/serviceController.js');

const { dualProtect, protect, authorize } = require('../middleware/auth.js');

// Public-ish routes (any authenticated user)
router.get('/', dualProtect, getServices);
router.get('/:id', dualProtect, getService);

// Admin/manager routes for services
router.post('/', protect, authorize('admin', 'manager'), createService);
router.put('/:id', protect, authorize('admin', 'manager'), updateService);
router.delete('/:id', protect, authorize('admin'), deleteService);

// Service category routes
router.get('/:serviceId/categories', dualProtect, getServiceCategories);
router.post('/:serviceId/categories', protect, authorize('admin', 'manager'), createServiceCategory);
router.put('/:serviceId/categories/:id', protect, authorize('admin', 'manager'), updateServiceCategory);
router.delete('/:serviceId/categories/:id', protect, authorize('admin'), deleteServiceCategory);

module.exports = router;
