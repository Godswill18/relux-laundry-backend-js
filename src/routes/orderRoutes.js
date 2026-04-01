const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrderCounts,
  getStaffCounts,
  getOrder,
  updateOrder,
  updateOrderStatus,
  assignStaff,
  acceptOrder,
  updatePayment,
  cancelOrder,
  lookupByQR,
  scanDelivery,
  addOrderItem,
  removeOrderItem,
  addOrderMedia,
  getOrderMedia,
} = require('../controllers/orderController.js');

const { protect, authorize } = require('../middleware/auth.js');
const { orderLimiter } = require('../middleware/rateLimiter.js');

// All routes require authentication (JWT tokens)
router.use(protect);

router.route('/')
  .get(getOrders)
  .post(orderLimiter, createOrder);

// Must be before /:id to avoid route conflict
router.get('/counts',       authorize('staff', 'admin', 'manager', 'receptionist'), getOrderCounts);
router.get('/staff-counts', authorize('staff', 'admin', 'manager', 'receptionist'), getStaffCounts);
router.post('/lookup-by-qr', authorize('staff', 'admin', 'manager'), lookupByQR);
router.post('/scan-delivery', authorize('staff', 'admin', 'manager'), scanDelivery);

router.route('/:id')
  .get(getOrder)
  .put(authorize('staff', 'admin', 'manager'), updateOrder);

router.patch('/:id/status', authorize('staff', 'admin', 'manager'), updateOrderStatus);
router.patch('/:id/accept', authorize('staff', 'admin', 'manager'), acceptOrder);
router.patch('/:id/assign', authorize('admin', 'manager'), assignStaff);
router.put('/:id/payment', authorize('staff', 'admin', 'manager'), updatePayment);
router.put('/:id/cancel', cancelOrder);

// Order items
router.post('/:id/items', addOrderItem);
router.delete('/:id/items/:itemId', removeOrderItem);

// Order media
router.get('/:id/media', getOrderMedia);
router.post('/:id/media', addOrderMedia);

module.exports = router;
