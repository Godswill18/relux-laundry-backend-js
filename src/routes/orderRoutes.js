const express = require('express');
const router = express.Router();
const {
  createOrder,
  getOrders,
  getOrderCounts,
  getOrderDashboardStats,
  getStaffCounts,
  getMyStats,
  getLeaderboard,
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
  customerPayWithWallet,
  cancelOrder,
  lookupByQR,
  scanDelivery,
  addOrderItem,
  removeOrderItem,
  markItemsReady,
  collectItems,
  getOrderCollections,
  addOrderMedia,
  getOrderMedia,
  backfillWalkIn,
} = require('../controllers/orderController.js');
const { exportOrdersExcel, exportOrdersPDF } = require('../controllers/exportController.js');
const {
  getOrderNotes,
  createOrderNote,
  updateOrderNote,
  deleteOrderNote,
} = require('../controllers/orderNoteController.js');

const { protect, authorize } = require('../middleware/auth.js');
const { orderLimiter } = require('../middleware/rateLimiter.js');

// All routes require authentication (JWT tokens)
router.use(protect);

router.route('/')
  .get(getOrders)
  .post(orderLimiter, createOrder);

// Must be before /:id to avoid route conflict
router.get('/counts',          authorize('staff', 'admin', 'manager', 'receptionist'), getOrderCounts);
router.get('/dashboard-stats', authorize('admin', 'manager'), getOrderDashboardStats);
router.get('/export/excel',    authorize('admin', 'manager'), exportOrdersExcel);
router.get('/export/pdf',      authorize('admin', 'manager'), exportOrdersPDF);
router.get('/staff-counts', authorize('staff', 'admin', 'manager', 'receptionist'), getStaffCounts);
router.get('/my-stats',         authorize('customer'), getMyStats);
router.get('/leaderboard',      getLeaderboard);
router.post('/backfill-walkin', authorize('admin'), backfillWalkIn);
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
router.post('/:id/pay-wallet', customerPayWithWallet);
// Delivery agents are deliberately excluded — cancelling is a counter/customer action
router.put('/:id/cancel', authorize('customer', 'staff', 'admin', 'manager', 'receptionist'), cancelOrder);

// Order items — editing an order's contents is a counter action, same authority
// as PUT /:id. These previously carried no authorize() at all.
router.post('/:id/items', authorize('staff', 'admin', 'manager', 'receptionist'), addOrderItem);
router.delete('/:id/items/:itemId', authorize('staff', 'admin', 'manager', 'receptionist'), removeOrderItem);

// Garment readiness and collection — counter actions. Delivery agents are
// excluded: a delivery is recorded through the delivered status / scan.
router.post('/:id/items/ready', authorize('staff', 'admin', 'manager', 'receptionist'), markItemsReady);
router.post('/:id/collections', authorize('staff', 'admin', 'manager', 'receptionist'), collectItems);
// Customers may read the history of their own orders (checked in the handler)
router.get('/:id/collections', getOrderCollections);

// Internal staff handover notes — never reachable by a customer. Deliberately
// not gated by VIEW_ORDERS-style read access alone: only the counter/processing
// roles that actually work an order can see or leave notes on it.
const NOTE_ROLES = ['staff', 'admin', 'manager', 'receptionist', 'developer'];
router.route('/:id/notes')
  .get(authorize(...NOTE_ROLES), getOrderNotes)
  .post(authorize(...NOTE_ROLES), createOrderNote);
router.patch('/:id/notes/:noteId', authorize(...NOTE_ROLES), updateOrderNote);
// Deleting (soft) is a manager/admin action — not every staff member may
// remove another person's operational history.
router.delete('/:id/notes/:noteId', authorize('admin', 'manager', 'developer'), deleteOrderNote);

// Order media
router.get('/:id/media', getOrderMedia);
router.post('/:id/media', addOrderMedia);

module.exports = router;
