const multer   = require('multer');
const AppError = require('../utils/appError.js');

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function imageFileFilter(_req, file, cb) {
  if (IMAGE_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
  cb(new AppError('Only image files are allowed (jpg, png, webp, gif)', 415), false);
}

exports.uploadAnnouncementImage = multer({
  storage:    multer.memoryStorage(),
  fileFilter: imageFileFilter,
  limits:     { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('image');
