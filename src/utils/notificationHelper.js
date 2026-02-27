// ============================================================================
// NOTIFICATION HELPER - Automated Notification Creation and Socket.io Events
// ============================================================================

const Notification = require('../models/Notification.js');

/**
 * Create a notification and emit Socket.io event
 * @param {Object} params - Notification parameters
 * @param {string} params.userId - User ID (optional, either userId or customerId required)
 * @param {string} params.customerId - Customer ID (optional, either userId or customerId required)
 * @param {string} params.type - Notification type (order_created, order_status_updated, etc.)
 * @param {string} params.title - Notification title
 * @param {string} params.body - Notification message
 * @param {Object} params.metadata - Additional data (optional)
 * @param {string} params.channel - Notification channel (default: 'in_app')
 * @param {Object} io - Socket.io instance (optional, from req.app.get('io'))
 * @returns {Promise<Object>} Created notification
 */
const createNotification = async (params, io = null) => {
  try {
    const { userId, customerId, type, title, body, metadata = {}, channel = 'in_app' } = params;

    // Validate required fields
    if (!userId && !customerId) {
      throw new Error('Either userId or customerId is required');
    }

    if (!type || !title || !body) {
      throw new Error('type, title, and body are required');
    }

    // Create notification
    const notification = await Notification.create({
      userId,
      customerId,
      type,
      channel,
      title,
      body,
      metadata,
    });

    // Emit Socket.io event for realtime delivery
    if (io) {
      const targetRoom = userId ? `user-${userId}` : `user-${customerId}`;
      io.to(targetRoom).emit('notification:new', {
        id: notification._id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        metadata: notification.metadata,
        createdAt: notification.createdAt,
      });
    }

    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
};

/**
 * Create order status update notification
 * @param {Object} order - Order object
 * @param {string} status - New status
 * @param {Object} io - Socket.io instance
 */
const notifyOrderStatusUpdate = async (order, status, io) => {
  const statusMessages = {
    pending: 'Your order has been received and is pending processing',
    confirmed: 'Your order has been confirmed',
    in_progress: 'Your order is now being processed',
    ready: 'Your order is ready for pickup/delivery',
    out_for_delivery: 'Your order is out for delivery',
    completed: 'Your order has been completed',
    cancelled: 'Your order has been cancelled',
  };

  const message = statusMessages[status.toLowerCase()] || `Your order status has been updated to ${status}`;

  return await createNotification({
    customerId: order.customer._id || order.customer,
    type: 'order_status_updated',
    title: `Order ${order.orderNumber || 'Update'}`,
    body: message,
    metadata: {
      orderId: order._id,
      orderNumber: order.orderNumber,
      status,
    },
  }, io);
};

/**
 * Create order created notification
 * @param {Object} order - Order object
 * @param {Object} io - Socket.io instance
 */
const notifyOrderCreated = async (order, io) => {
  return await createNotification({
    customerId: order.customer._id || order.customer,
    type: 'order_created',
    title: 'Order Created',
    body: `Your order ${order.orderNumber} has been created successfully`,
    metadata: {
      orderId: order._id,
      orderNumber: order.orderNumber,
      total: order.pricing?.total || order.payment?.amount,
    },
  }, io);
};

/**
 * Create wallet transaction notification
 * @param {string} customerId - Customer ID
 * @param {string} type - Transaction type (credit/debit)
 * @param {number} amount - Transaction amount
 * @param {string} reason - Transaction reason
 * @param {Object} io - Socket.io instance
 */
const notifyWalletTransaction = async (customerId, type, amount, reason, io) => {
  const title = type === 'credit' ? 'Wallet Credited' : 'Wallet Debited';
  const body = type === 'credit'
    ? `₦${amount.toLocaleString()} has been added to your wallet. ${reason}`
    : `₦${amount.toLocaleString()} has been deducted from your wallet. ${reason}`;

  return await createNotification({
    customerId,
    type: 'order_created', // Using closest type, can be extended
    title,
    body,
    metadata: {
      type,
      amount,
      reason,
    },
  }, io);
};

/**
 * Create referral reward notification
 * @param {string} customerId - Customer ID
 * @param {number} amount - Reward amount
 * @param {string} refereeName - Name of the referred customer
 * @param {Object} io - Socket.io instance
 */
const notifyReferralReward = async (customerId, amount, refereeName, io) => {
  return await createNotification({
    customerId,
    type: 'order_created', // Using closest type, can be extended
    title: 'Referral Reward Received!',
    body: `You've earned ₦${amount.toLocaleString()} for referring ${refereeName}!`,
    metadata: {
      amount,
      refereeName,
    },
  }, io);
};

module.exports = {
  createNotification,
  notifyOrderStatusUpdate,
  notifyOrderCreated,
  notifyWalletTransaction,
  notifyReferralReward,
};
