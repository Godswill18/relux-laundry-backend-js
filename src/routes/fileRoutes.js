const express      = require('express');
const multer       = require('multer');
const AppError     = require('../utils/appError.js');
const asyncHandler = require('../utils/asyncHandler.js');
const storage      = require('../lib/storage.js');
const { logAudit } = require('../utils/auditLogger.js');
const { protect, noCustomers, authorize } = require('../middleware/auth.js');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    // Explicit raster allow-list — `image/*` would also admit SVG (script-capable).
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      return cb(new AppError('Only image files are allowed', 415), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
}).single('file');

// Prefix becomes part of the storage key: letters, digits, dash, underscore and
// single slashes only — no '..', no leading slash.
const SAFE_PREFIX = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/;
const safePrefix = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return typeof value === 'string' && value.length <= 64 && SAFE_PREFIX.test(value) ? value : null;
};

// All file management routes require a valid staff JWT
router.use(protect, noCustomers);

// POST /api/v1/files — upload a new file
// Query: ?prefix=announcements  (default: 'uploads')
router.post('/', upload, asyncHandler(async (req, res, next) => {
  if (!req.file) return next(new AppError('No file provided', 400));
  const prefix = safePrefix(req.query.prefix, 'uploads');
  if (!prefix) return next(new AppError('Invalid prefix', 400));
  const { key, url } = await storage.uploadFile(
    req.file.buffer, req.file.originalname, req.file.mimetype, prefix,
  );
  res.status(201).json({ success: true, data: { key, url } });
}));

// GET /api/v1/files — list files
// Query: ?prefix=announcements  (default: all)
router.get('/', asyncHandler(async (req, res, next) => {
  const prefix = safePrefix(req.query.prefix, '');
  if (prefix === null) return next(new AppError('Invalid prefix', 400));
  const files = await storage.listFiles(prefix);
  res.status(200).json({ success: true, data: { files } });
}));

// PUT /api/v1/files/:key — replace a file (key may contain slashes)
// Destructive: restricted to admin/manager. Previously any staff role — including
// delivery — could overwrite or delete arbitrary keys in the bucket.
router.put('/:key(*)', authorize('admin', 'manager'), upload, asyncHandler(async (req, res, next) => {
  if (!req.file) return next(new AppError('No file provided', 400));
  const oldKey = decodeURIComponent(req.params.key);
  const { key, url } = await storage.replaceFile(oldKey, req.file.buffer, req.file.mimetype);
  res.status(200).json({ success: true, data: { key, url } });
}));

// DELETE /api/v1/files/:key — delete a file (key may contain slashes)
// Destructive and unrecoverable: admin only, and audited.
router.delete('/:key(*)', authorize('admin'), asyncHandler(async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  await storage.deleteFile(key);
  await logAudit({
    actorUserId: req.user.id,
    action: 'FILE_DELETED',
    targetType: 'File',
    targetId: key,
  });
  res.status(200).json({ success: true, message: 'File deleted' });
}));

module.exports = router;
