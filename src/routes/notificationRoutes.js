const express = require('express');
const router = express.Router();
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  getPreferences,
  updatePreferences,
  getVapidPublicKey,
  subscribePush,
  unsubscribePush,
} = require('../controllers/notificationController.js');

const { protect } = require('../middleware/auth.js');

// Public — frontend needs the key before subscribing
router.get('/vapid-public-key', getVapidPublicKey);

router.use(protect);

router.get('/', getNotifications);

router.post('/push-subscribe', subscribePush);
router.delete('/push-subscribe', unsubscribePush);

router.get('/unread-count', getUnreadCount);
router.put('/read-all', markAllAsRead);

router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);

router.put('/:id/read', markAsRead);

module.exports = router;
