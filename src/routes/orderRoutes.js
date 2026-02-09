const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrder,
  updateOrderStatus,
  assignStaff,
  updatePayment,
  cancelOrder,
  addOrderItem,
  removeOrderItem,
  addOrderMedia,
  getOrderMedia,
} = require('../controllers/orderController.js');

const { dualProtect, authorize } = require('../middleware/auth.js');
const { orderLimiter } = require('../middleware/rateLimiter.js');

// All routes require authentication (accepts both JWT and Clerk tokens)
router.use(dualProtect);

router.route('/')
  .get(getOrders)
  .post(orderLimiter, createOrder);

router.route('/:id')
  .get(getOrder);

router.put('/:id/status', authorize('staff', 'admin', 'manager'), updateOrderStatus);
router.put('/:id/assign', authorize('admin', 'manager'), assignStaff);
router.put('/:id/payment', authorize('staff', 'admin', 'manager'), updatePayment);
router.put('/:id/cancel', cancelOrder);

// Order items
router.post('/:id/items', addOrderItem);
router.delete('/:id/items/:itemId', removeOrderItem);

// Order media
router.get('/:id/media', getOrderMedia);
router.post('/:id/media', addOrderMedia);

module.exports = router;
