const Announcement = require('../models/Announcement.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError     = require('../utils/appError.js');
const storage      = require('../lib/storage.js');

// ── Image helpers ─────────────────────────────────────────────────────────────

// Delete a stored announcement image.
// Handles both MinIO URLs and legacy local /uploads/... paths (backward compat).
async function deleteStoredImage(imageUrl) {
  if (!imageUrl) return;
  const key = storage.extractKey(imageUrl);
  if (key) {
    await storage.deleteFile(key).catch(() => {});
    return;
  }
  // Legacy local file — delete from disk if it exists
  try {
    const fs   = require('fs');
    const path = require('path');
    let pathname = imageUrl;
    if (imageUrl.startsWith('http')) {
      try { pathname = new URL(imageUrl).pathname; } catch { return; }
    }
    if (pathname.startsWith('/uploads/')) {
      const fullPath = path.join(process.cwd(), pathname);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  } catch { /* non-critical */ }
}

// Normalize any stored imageUrl for API responses:
//   - Absolute URLs (MinIO / any CDN) → returned as-is
//   - Legacy relative /uploads/... paths → rebased to the current backend host
function normalizeImageUrl(imageUrl, req) {
  if (!imageUrl) return imageUrl;
  if (imageUrl.startsWith('http')) return imageUrl;
  const pathname = imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`;
  return `${req.protocol}://${req.get('host')}${pathname}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Map backend role to targetAudience filter
function audienceFilter(role) {
  const staffRoles = ['admin', 'manager', 'staff', 'receptionist', 'delivery'];
  if (staffRoles.includes(role)) {
    return { $in: ['staff', 'both'] };
  }
  return { $in: ['customer', 'both'] };
}

// ── Get active announcements for the requesting user ─────────────────────────
// @route   GET /api/v1/announcements/active
// @access  Private
exports.getActiveAnnouncements = asyncHandler(async (req, res) => {
  const now = new Date();
  const filter = {
    active:           true,
    startDate:        { $lte: now },
    endDate:          { $gte: now },
    targetAudience:   audienceFilter(req.user.role),
  };

  const announcements = (await Announcement.find(filter)
    .sort({ priority: -1, createdAt: -1 })
    .lean()
  ).map((a) => ({ ...a, imageUrl: normalizeImageUrl(a.imageUrl, req) }));

  res.status(200).json({
    success: true,
    message: 'Active announcements fetched',
    data: { announcements },
  });
});

// ── Admin: Get all announcements (paginated) ──────────────────────────────────
// @route   GET /api/v1/announcements
// @access  Private (Admin/Manager)
exports.getAnnouncements = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
  const skip  = (page - 1) * limit;

  let query = {};
  if (req.query.active    !== undefined) query.active          = req.query.active === 'true';
  if (req.query.type)                    query.type            = req.query.type;
  if (req.query.audience)               query.targetAudience  = req.query.audience;

  const [total, raw] = await Promise.all([
    Announcement.countDocuments(query),
    Announcement.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);
  const announcements = raw.map((a) => ({ ...a, imageUrl: normalizeImageUrl(a.imageUrl, req) }));

  res.status(200).json({
    success: true,
    message: 'Announcements fetched',
    data: { announcements },
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
});

// ── Admin: Get single announcement ───────────────────────────────────────────
// @route   GET /api/v1/announcements/:id
// @access  Private (Admin/Manager)
exports.getAnnouncement = asyncHandler(async (req, res, next) => {
  const item = await Announcement.findById(req.params.id).lean();
  if (!item) return next(new AppError('Announcement not found', 404));

  res.status(200).json({
    success: true,
    message: 'Announcement fetched',
    data: { announcement: { ...item, imageUrl: normalizeImageUrl(item.imageUrl, req) } },
  });
});

// ── Admin: Create announcement ────────────────────────────────────────────────
// @route   POST /api/v1/announcements
// @access  Private (Admin/Manager)
exports.createAnnouncement = asyncHandler(async (req, res, next) => {
  const {
    title, message, type, targetAudience, displayMode,
    imageUrl, ctaLabel, ctaUrl, startDate, endDate, priority,
  } = req.body;

  if (!title || !title.trim())   return next(new AppError('Title is required', 400));
  if (!message || !message.trim()) return next(new AppError('Message is required', 400));
  if (!startDate || !endDate)    return next(new AppError('startDate and endDate are required', 400));
  if (new Date(endDate) <= new Date(startDate)) {
    return next(new AppError('endDate must be after startDate', 400));
  }

  const item = await Announcement.create({
    title:          title.trim(),
    message:        message.trim(),
    type:           type           || 'announcement',
    targetAudience: targetAudience || 'both',
    displayMode:    displayMode    || 'banner',
    imageUrl:       imageUrl       || '',
    ctaLabel:       ctaLabel       || '',
    ctaUrl:         ctaUrl         || '',
    startDate:      new Date(startDate),
    endDate:        new Date(endDate),
    priority:       priority != null ? Number(priority) : 0,
    createdBy:      req.user.id,
  });

  res.status(201).json({
    success: true,
    message: 'Announcement created',
    data: { announcement: item },
  });
});

// ── Admin: Update announcement ────────────────────────────────────────────────
// @route   PUT /api/v1/announcements/:id
// @access  Private (Admin/Manager)
exports.updateAnnouncement = asyncHandler(async (req, res, next) => {
  const item = await Announcement.findById(req.params.id);
  if (!item) return next(new AppError('Announcement not found', 404));

  // If imageUrl is being replaced, delete the old stored image
  if (req.body.imageUrl !== undefined && req.body.imageUrl !== item.imageUrl) {
    await deleteStoredImage(item.imageUrl);
  }

  const fields = [
    'title', 'message', 'type', 'targetAudience', 'displayMode',
    'imageUrl', 'ctaLabel', 'ctaUrl', 'startDate', 'endDate', 'priority', 'active',
  ];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) item[f] = req.body[f];
  });

  if (item.endDate <= item.startDate) {
    return next(new AppError('endDate must be after startDate', 400));
  }

  await item.save();
  res.status(200).json({
    success: true,
    message: 'Announcement updated',
    data: { announcement: item },
  });
});

// ── Admin: Delete announcement ────────────────────────────────────────────────
// @route   DELETE /api/v1/announcements/:id
// @access  Private (Admin)
exports.deleteAnnouncement = asyncHandler(async (req, res, next) => {
  const item = await Announcement.findById(req.params.id);
  if (!item) return next(new AppError('Announcement not found', 404));

  // Delete the stored image from MinIO (or local disk for legacy files)
  await deleteStoredImage(item.imageUrl);

  await item.deleteOne();
  res.status(200).json({
    success: true,
    message: 'Announcement deleted',
    data: {},
  });
});

// ── Upload announcement image ─────────────────────────────────────────────────
// @route   POST /api/v1/announcements/upload-image
// @access  Private (Admin/Manager)
// Multer middleware (memoryStorage) is applied in the route — req.file.buffer is the image data.
exports.uploadAnnouncementImage = asyncHandler(async (req, res, next) => {
  if (!req.file) return next(new AppError('No image file provided', 400));
  const { url } = await storage.uploadFile(
    req.file.buffer,
    req.file.originalname,
    req.file.mimetype,
    'announcements',
  );
  res.status(200).json({
    success: true,
    message: 'Image uploaded successfully',
    data: { imageUrl: url },
  });
});
