const express = require('express');
const router = express.Router();
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  getPreferences,
  updatePreferences,
} = require('../controllers/notificationController.js');

const { protect } = require('../middleware/auth.js');

router.use(protect);

router.get('/', getNotifications);

router.get('/unread-count', getUnreadCount);
router.put('/read-all', markAllAsRead);

router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);

router.put('/:id/read', markAsRead);

module.exports = router;
