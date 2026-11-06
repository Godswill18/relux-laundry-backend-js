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

  const image = await acceptImage(imageUrl);

  const item = await Announcement.create({
    title:          title.trim(),
    message:        message.trim(),
    type:           type           || 'announcement',
    targetAudience: targetAudience || 'both',
    displayMode:    displayMode    || 'banner',
    imageUrl:       image,
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

  const previousImage = item.imageUrl;
  if (req.body.imageUrl !== undefined) req.body.imageUrl = await acceptImage(req.body.imageUrl, item.imageUrl);

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

  // Only once the new reference is saved: a failed edit must never cost the
  // announcement its existing image.
  if (previousImage && previousImage !== item.imageUrl) await deleteStoredImage(previousImage);

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

// ── Announcement images: direct browser → MinIO uploads ─────────────────────
// The API never receives image bytes. It signs an upload URL, then, when the
// announcement is saved, checks the uploaded object before storing its URL.
const DIRECT_PREFIX = 'announcements/direct';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // same limit as before
const DIRECT_KEY = /^announcements\/direct\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;
const EXT_OK = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'image/gif': ['gif'] };

// @route   POST /api/v1/announcements/upload-url   { fileName, contentType, size }
// @access  Private (Admin/Manager)
exports.getAnnouncementUploadUrl = asyncHandler(async (req, res, next) => {
  const { fileName, contentType } = req.body;
  const size = Number(req.body.size);
  if (!storage.IMAGE_EXT[contentType]) {
    return next(new AppError('Only JPG, PNG, WebP or GIF images can be uploaded', 415));
  }
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  if (fileName && !EXT_OK[contentType].includes(ext)) {
    return next(new AppError("The file's extension doesn't match its type", 415));
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
    return next(new AppError('Images must be 5 MB or smaller', 413));
  }
  const upload = await storage.createPresignedUpload({ prefix: DIRECT_PREFIX, contentType, size });
  res.status(200).json({
    success: true,
    data: {
      uploadUrl: upload.uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      key: upload.key,
      imageUrl: upload.url,
      expiresIn: upload.expiresIn,
    },
  });
});

/**
 * The image to store for an announcement. Accepts: no image, the announcement's
 * current image unchanged, or a direct upload this API signed — verified to
 * exist and to really be an image. Anything else (another URL, another key,
 * an expiring signed URL) is refused.
 */
async function acceptImage(imageUrl, current = '') {
  if (!imageUrl) return '';
  if (imageUrl === current) return current;
  const key = storage.keyFromAnyUrl(imageUrl);
  if (!key || !DIRECT_KEY.test(key) || imageUrl.includes('?')) {
    throw new AppError('Upload the image again — that image reference is not valid.', 400);
  }
  const check = await storage.verifyUploadedImage(key, { maxBytes: MAX_IMAGE_BYTES });
  if (!check.ok) {
    if (['type', 'size', 'content'].includes(check.reason)) await storage.deleteFile(key).catch(() => {});
    const msg = {
      missing: 'The image upload did not finish. Please upload it again.',
      unreachable: 'Image storage is unavailable right now. Please try again.',
      type: 'Only JPG, PNG, WebP or GIF images can be used.',
      size: 'Images must be 5 MB or smaller.',
      content: "That file isn't a valid image.",
    }[check.reason];
    throw new AppError(msg, check.reason === 'unreachable' ? 503 : 400);
  }
  return storage.getFileUrl(key);
}

/**
 * Remove direct uploads nobody saved (form closed after uploading). Only
 * touches announcements/direct/, only objects over a day old, and only ones no
 * announcement references. Existing images elsewhere are never considered.
 */
exports.cleanupAbandonedAnnouncementUploads = async ({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) => {
  const files = await storage.listFiles(DIRECT_PREFIX + '/');
  const cutoff = Date.now() - olderThanMs;
  const old = files.filter((f) => f.lastModified && new Date(f.lastModified).getTime() < cutoff);
  if (!old.length) return 0;
  const used = new Set((await Announcement.find({ imageUrl: { $ne: '' } }).select('imageUrl').lean())
    .map((a) => storage.keyFromAnyUrl(a.imageUrl)).filter(Boolean));
  let removed = 0;
  for (const f of old) {
    if (used.has(f.key)) continue;
    await storage.deleteFile(f.key).then(() => { removed += 1; }).catch(() => {});
  }
  return removed;
};
