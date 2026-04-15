const mongoose = require('mongoose');

// ── Announcement / Promotion Model ───────────────────────────────────────────
// targetAudience: 'staff' | 'customer' | 'both'
// type:           'announcement' (text) | 'promotion' (can have image)
// displayMode:    'popup' | 'banner'
// ─────────────────────────────────────────────────────────────────────────────

const AnnouncementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['announcement', 'promotion'],
      default: 'announcement',
    },
    targetAudience: {
      type: String,
      enum: ['staff', 'customer', 'both'],
      default: 'both',
    },
    displayMode: {
      type: String,
      enum: ['popup', 'banner'],
      default: 'banner',
    },
    imageUrl: {
      type: String,
      default: '',
    },
    ctaLabel: {
      type: String,
      default: '',   // e.g. "Shop Now", "Learn More"
    },
    ctaUrl: {
      type: String,
      default: '',
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    priority: {
      type: Number,
      default: 0,   // higher = shown first
    },
    active: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// Index for efficient active-announcement queries
AnnouncementSchema.index({ active: 1, startDate: 1, endDate: 1, targetAudience: 1 });

module.exports = mongoose.model('Announcement', AnnouncementSchema);
