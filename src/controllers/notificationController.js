const Notification = require('../models/Notification.js');
const NotificationPreference = require('../models/NotificationPreference.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// Staff/admin broadcast types — saved without userId/customerId, visible to all staff
const BROADCAST_TYPES = ['order_created', 'order_cancelled', 'order_status_updated'];

/**
 * Build the Mongoose query for a given user's notifications.
 * Staff/admin roles see:
 *   - their personal notifications (userId = req.user.id)
 *   - broadcast admin notifications (no userId, no customerId, broadcast type)
 * Customers see notifications by customerId or userId.
 */
function buildNotifQuery(user) {
  const staffRoles = ['admin', 'manager', 'staff', 'receptionist'];
  if (user.role === 'customer') {
    return {
      $or: [
        { customerId: user.customerId },
        { userId: user.id },
      ],
    };
  }
  if (staffRoles.includes(user.role)) {
    return {
      $or: [
        { userId: user.id },
        { userId: null, customerId: null, type: { $in: BROADCAST_TYPES } },
      ],
    };
  }
  return { userId: user.id };
}

// @desc    Get my notifications
// @route   GET /api/v1/notifications
// @access  Private
exports.getNotifications = asyncHandler(async (req, res, next) => {
  const query = buildNotifQuery(req.user);

  if (req.query.type) query.type = req.query.type;
  if (req.query.read === 'true') {
    if (query.$or) {
      query.$or = query.$or.map(c => ({ ...c, readAt: { $ne: null } }));
    } else {
      query.readAt = { $ne: null };
    }
  }
  if (req.query.read === 'false') {
    if (query.$or) {
      query.$or = query.$or.map(c => ({ ...c, readAt: null }));
    } else {
      query.readAt = null;
    }
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const startIndex = (page - 1) * limit;

  const total = await Notification.countDocuments(query);

  const notifications = await Notification.find(query)
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Notifications fetched successfully',
    data: { notifications },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Mark notification as read
// @route   PUT /api/v1/notifications/:id/read
// @access  Private
exports.markAsRead = asyncHandler(async (req, res, next) => {
  const notification = await Notification.findById(req.params.id);

  if (!notification) {
    return next(new AppError('Notification not found', 404));
  }

  notification.readAt = new Date();
  await notification.save();

  res.status(200).json({
    success: true,
    message: 'Notification marked as read',
    data: { notification },
  });
});

// @desc    Mark all notifications as read
// @route   PUT /api/v1/notifications/read-all
// @access  Private
exports.markAllAsRead = asyncHandler(async (req, res, next) => {
  const base = buildNotifQuery(req.user);
  // Merge readAt: null into the query
  let query;
  if (base.$or) {
    query = { $or: base.$or.map(c => ({ ...c, readAt: null })) };
  } else {
    query = { ...base, readAt: null };
  }

  await Notification.updateMany(query, { readAt: new Date() });

  res.status(200).json({
    success: true,
    message: 'All notifications marked as read',
    data: {},
  });
});

// @desc    Get unread notification count
// @route   GET /api/v1/notifications/unread-count
// @access  Private
exports.getUnreadCount = asyncHandler(async (req, res, next) => {
  const base = buildNotifQuery(req.user);
  let query;
  if (base.$or) {
    query = { $or: base.$or.map(c => ({ ...c, readAt: null })) };
  } else {
    query = { ...base, readAt: null };
  }

  const count = await Notification.countDocuments(query);

  res.status(200).json({
    success: true,
    message: 'Unread count fetched',
    data: { count },
  });
});

// @desc    Delete read notifications older than 7 days (internal — called by scheduler)
// @access  Internal
exports.purgeOldReadNotifications = async () => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await Notification.deleteMany({
    readAt: { $ne: null, $lt: cutoff },
  });
  return result.deletedCount;
};

// @desc    Get notification preferences
// @route   GET /api/v1/notifications/preferences
// @access  Private
exports.getPreferences = asyncHandler(async (req, res, next) => {
  let preferences = await NotificationPreference.findOne({ userId: req.user.id });

  if (!preferences) {
    preferences = await NotificationPreference.create({
      userId: req.user.id,
      channels: ['in_app'],
      types: ['order_created', 'order_status_updated', 'order_due_soon', 'chat_message'],
    });
  }

  res.status(200).json({
    success: true,
    message: 'Preferences fetched successfully',
    data: { preferences },
  });
});

// @desc    Update notification preferences
// @route   PUT /api/v1/notifications/preferences
// @access  Private
exports.updatePreferences = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    channels: req.body.channels,
    types: req.body.types,
    muteAll: req.body.muteAll,
    quietHoursStart: req.body.quietHoursStart,
    quietHoursEnd: req.body.quietHoursEnd,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const preferences = await NotificationPreference.findOneAndUpdate(
    { userId: req.user.id },
    fieldsToUpdate,
    { new: true, upsert: true, runValidators: true }
  );

  res.status(200).json({
    success: true,
    message: 'Preferences updated successfully',
    data: { preferences },
  });
});
