const express = require('express');
const router = express.Router();
const {
  getServices,
  getService,
  createService,
  updateService,
  deleteService,
  reorderServices,
  getServiceCategories,
  createServiceCategory,
  updateServiceCategory,
  deleteServiceCategory,
  getAllCategories,
  createCategoryFlat,
  updateCategoryFlat,
  deleteCategoryFlat,
  getServiceLevels,
  createServiceLevel,
  updateServiceLevel,
  deleteServiceLevel,
  getPickupWindows,
  createPickupWindow,
  updatePickupWindow,
  deletePickupWindow,
  getDeliveryZones,
  createDeliveryZone,
  updateDeliveryZone,
  deleteDeliveryZone,
} = require('../controllers/serviceController.js');

const { protect, authorize } = require('../middleware/auth.js');

// ---- Static routes MUST come before /:id to avoid ObjectId cast errors ----

// Flat category routes (all categories, not scoped to a service)
router.get('/categories', protect, getAllCategories);
router.post('/categories', protect, authorize('admin', 'manager'), createCategoryFlat);
router.put('/categories/:id', protect, authorize('admin', 'manager'), updateCategoryFlat);
router.delete('/categories/:id', protect, authorize('admin'), deleteCategoryFlat);

// Service Level routes
router.get('/levels', protect, getServiceLevels);
router.post('/levels', protect, authorize('admin', 'manager'), createServiceLevel);
router.put('/levels/:id', protect, authorize('admin', 'manager'), updateServiceLevel);
router.delete('/levels/:id', protect, authorize('admin'), deleteServiceLevel);

// Pickup Window routes
router.get('/pickup-windows', protect, getPickupWindows);
router.post('/pickup-windows', protect, authorize('admin', 'manager'), createPickupWindow);
router.put('/pickup-windows/:id', protect, authorize('admin', 'manager'), updatePickupWindow);
router.delete('/pickup-windows/:id', protect, authorize('admin'), deletePickupWindow);

// Delivery Zone routes
router.get('/delivery-zones', protect, getDeliveryZones);
router.post('/delivery-zones', protect, authorize('admin', 'manager'), createDeliveryZone);
router.put('/delivery-zones/:id', protect, authorize('admin', 'manager'), updateDeliveryZone);
router.delete('/delivery-zones/:id', protect, authorize('admin'), deleteDeliveryZone);

// ---- Parameterized routes come after static routes ----

// Services CRUD
router.get('/', protect, getServices);
router.post('/', protect, authorize('admin', 'manager'), createService);
router.put('/reorder', protect, authorize('admin', 'manager'), reorderServices);
router.get('/:id', protect, getService);
router.put('/:id', protect, authorize('admin', 'manager'), updateService);
router.delete('/:id', protect, authorize('admin'), deleteService);

// Nested service category routes (scoped to a specific service)
router.get('/:serviceId/categories', protect, getServiceCategories);
router.post('/:serviceId/categories', protect, authorize('admin', 'manager'), createServiceCategory);
router.put('/:serviceId/categories/:id', protect, authorize('admin', 'manager'), updateServiceCategory);
router.delete('/:serviceId/categories/:id', protect, authorize('admin'), deleteServiceCategory);

module.exports = router;
