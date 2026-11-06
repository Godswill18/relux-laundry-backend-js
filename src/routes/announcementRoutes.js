const express = require('express');
const router  = express.Router();
const {
  getActiveAnnouncements,
  getAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  getAnnouncementUploadUrl,
} = require('../controllers/announcementController.js');
const { protect, authorize } = require('../middleware/auth.js');

// Active announcements for current user's role — any authenticated user
router.get('/active', protect, getActiveAnnouncements);

// Signed URL for a direct browser → MinIO image upload. The image itself never
// comes through the API. (Must be before /:id routes.)
router.post('/upload-url', protect, authorize('admin', 'manager'), getAnnouncementUploadUrl);

// Admin/Manager CRUD
router.get('/',    protect, authorize('admin', 'manager'), getAnnouncements);
router.post('/',   protect, authorize('admin', 'manager'), createAnnouncement);
router.get('/:id', protect, authorize('admin', 'manager'), getAnnouncement);
router.put('/:id', protect, authorize('admin', 'manager'), updateAnnouncement);
router.delete('/:id', protect, authorize('admin'), deleteAnnouncement);

module.exports = router;
