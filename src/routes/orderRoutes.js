const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrderCounts,
  getStaffCounts,
  getMyStats,
  getOrder,
  updateOrder,
  updateOrderStatus,
  assignStaff,
  acceptOrder,
  acceptPickup,
  acceptDelivery,
  scanPickup,
  updatePayment,
  payBalanceFromWallet,
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
router.get('/my-stats',     authorize('customer'), getMyStats);
router.post('/lookup-by-qr', authorize('staff', 'admin', 'manager', 'delivery'), lookupByQR);
router.post('/scan-delivery', authorize('staff', 'admin', 'manager', 'delivery'), scanDelivery);
router.post('/scan-pickup',   authorize('staff', 'admin', 'manager', 'delivery'), scanPickup);

router.route('/:id')
  .get(getOrder)
  .put(authorize('staff', 'admin', 'manager'), updateOrder);

router.patch('/:id/status',           authorize('staff', 'admin', 'manager', 'delivery'), updateOrderStatus);
router.patch('/:id/accept',           authorize('staff', 'admin', 'manager'), acceptOrder);
router.patch('/:id/accept-pickup',    authorize('delivery', 'admin', 'manager'), acceptPickup);
router.patch('/:id/accept-delivery',  authorize('delivery', 'admin', 'manager'), acceptDelivery);
router.patch('/:id/assign',           authorize('admin', 'manager'), assignStaff);
router.put('/:id/payment', authorize('staff', 'admin', 'manager'), updatePayment);
router.post('/:id/pay-balance', authorize('staff', 'admin', 'manager'), payBalanceFromWallet);
router.put('/:id/cancel', cancelOrder);

// Order items
router.post('/:id/items', addOrderItem);
router.delete('/:id/items/:itemId', removeOrderItem);

// Order media
router.get('/:id/media', getOrderMedia);
router.post('/:id/media', addOrderMedia);

module.exports = router;
