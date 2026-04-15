const path          = require('path');
const fs            = require('fs');
const Announcement  = require('../models/Announcement.js');
const asyncHandler  = require('../utils/asyncHandler.js');
const AppError      = require('../utils/appError.js');

// ── Image helpers ─────────────────────────────────────────────────────────────

// Delete a local uploaded file by its stored path (e.g. "/uploads/announcements/xxx.jpg")
function deleteLocalFile(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/uploads/')) return;
  try {
    const filePath = path.join(__dirname, '..', imageUrl);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch { /* non-critical */ }
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

  const announcements = await Announcement.find(filter)
    .sort({ priority: -1, createdAt: -1 })
    .lean();

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

  const [total, announcements] = await Promise.all([
    Announcement.countDocuments(query),
    Announcement.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

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
    data: { announcement: item },
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

  // If imageUrl is being replaced, delete the old local file
  if (req.body.imageUrl !== undefined && req.body.imageUrl !== item.imageUrl) {
    deleteLocalFile(item.imageUrl);
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

  // Clean up local image if stored on this server
  deleteLocalFile(item.imageUrl);

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
// Multer middleware is applied in the route — req.file is the uploaded file.
exports.uploadAnnouncementImage = asyncHandler(async (req, res, next) => {
  if (!req.file) return next(new AppError('No image file provided', 400));

  const imageUrl = `/uploads/announcements/${req.file.filename}`;
  res.status(200).json({
    success: true,
    message: 'Image uploaded successfully',
    data: { imageUrl },
  });
});
