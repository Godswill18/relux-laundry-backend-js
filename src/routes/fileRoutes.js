const express      = require('express');
const multer       = require('multer');
const AppError     = require('../utils/appError.js');
const asyncHandler = require('../utils/asyncHandler.js');
const storage      = require('../lib/storage.js');
const { protect, noCustomers } = require('../middleware/auth.js');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new AppError('Only image files are allowed', 415), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('file');

// All file management routes require a valid staff JWT
router.use(protect, noCustomers);

// POST /api/v1/files — upload a new file
// Query: ?prefix=announcements  (default: 'uploads')
router.post('/', upload, asyncHandler(async (req, res, next) => {
  if (!req.file) return next(new AppError('No file provided', 400));
  const prefix = req.query.prefix || 'uploads';
  const { key, url } = await storage.uploadFile(
    req.file.buffer, req.file.originalname, req.file.mimetype, prefix,
  );
  res.status(201).json({ success: true, data: { key, url } });
}));

// GET /api/v1/files — list files
// Query: ?prefix=announcements  (default: all)
router.get('/', asyncHandler(async (req, res) => {
  const files = await storage.listFiles(req.query.prefix || '');
  res.status(200).json({ success: true, data: { files } });
}));

// PUT /api/v1/files/:key — replace a file (key may contain slashes)
router.put('/:key(*)', upload, asyncHandler(async (req, res, next) => {
  if (!req.file) return next(new AppError('No file provided', 400));
  const oldKey = decodeURIComponent(req.params.key);
  const { key, url } = await storage.replaceFile(oldKey, req.file.buffer, req.file.mimetype);
  res.status(200).json({ success: true, data: { key, url } });
}));

// DELETE /api/v1/files/:key — delete a file (key may contain slashes)
router.delete('/:key(*)', asyncHandler(async (req, res) => {
  await storage.deleteFile(decodeURIComponent(req.params.key));
  res.status(200).json({ success: true, message: 'File deleted' });
}));

module.exports = router;
