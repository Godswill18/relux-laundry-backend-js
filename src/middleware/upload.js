const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

// ── Announcement images ───────────────────────────────────────────────────────

const ANNOUNCEMENT_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'announcements');

// Ensure directory exists on first require
if (!fs.existsSync(ANNOUNCEMENT_UPLOAD_DIR)) {
  fs.mkdirSync(ANNOUNCEMENT_UPLOAD_DIR, { recursive: true });
}

const announcementStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ANNOUNCEMENT_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const imageFileFilter = (_req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (jpg, jpeg, png, webp, gif) are allowed'), false);
  }
};

exports.uploadAnnouncementImage = multer({
  storage: announcementStorage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('image');
