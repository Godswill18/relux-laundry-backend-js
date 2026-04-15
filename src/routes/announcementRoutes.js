const express = require('express');
const router  = express.Router();
const {
  getActiveAnnouncements,
  getAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  uploadAnnouncementImage,
} = require('../controllers/announcementController.js');
const { protect, authorize }                    = require('../middleware/auth.js');
const { uploadAnnouncementImage: multerUpload } = require('../middleware/upload.js');

// Active announcements for current user's role — any authenticated user
router.get('/active', protect, getActiveAnnouncements);

// Image upload (must be before /:id routes to avoid conflict)
router.post(
  '/upload-image',
  protect,
  authorize('admin', 'manager'),
  multerUpload,
  uploadAnnouncementImage,
);

// Admin/Manager CRUD
router.get('/',    protect, authorize('admin', 'manager'), getAnnouncements);
router.post('/',   protect, authorize('admin', 'manager'), createAnnouncement);
router.get('/:id', protect, authorize('admin', 'manager'), getAnnouncement);
router.put('/:id', protect, authorize('admin', 'manager'), updateAnnouncement);
router.delete('/:id', protect, authorize('admin'), deleteAnnouncement);

module.exports = router;
