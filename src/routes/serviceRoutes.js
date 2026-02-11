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

const { protect, authorize } = require('../middleware/auth.js');

// Public-ish routes (any authenticated user)
router.get('/', protect, getServices);
router.get('/:id', protect, getService);

// Admin/manager routes for services
router.post('/', protect, authorize('admin', 'manager'), createService);
router.put('/:id', protect, authorize('admin', 'manager'), updateService);
router.delete('/:id', protect, authorize('admin'), deleteService);

// Service category routes
router.get('/:serviceId/categories', protect, getServiceCategories);
router.post('/:serviceId/categories', protect, authorize('admin', 'manager'), createServiceCategory);
router.put('/:serviceId/categories/:id', protect, authorize('admin', 'manager'), updateServiceCategory);
router.delete('/:serviceId/categories/:id', protect, authorize('admin'), deleteServiceCategory);

module.exports = router;
