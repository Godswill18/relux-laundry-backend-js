const mongoose = require('mongoose');

const WorkShiftSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Separate date/time fields (WAT timezone)
    startDate: { type: String, required: true }, // "YYYY-MM-DD"
    startTime: { type: String, required: true }, // "HH:MM" (24-hour, WAT)
    endDate: { type: String, required: true },   // "YYYY-MM-DD"
    endTime: { type: String, required: true },   // "HH:MM" (24-hour, WAT)

    shiftType: {
      type: String,
      enum: ['morning', 'afternoon', 'evening', 'night', 'full-day', 'custom'],
      default: 'custom',
    },

    status: {
      type: String,
      enum: ['scheduled', 'in-progress', 'completed', 'cancelled'],
      default: 'scheduled',
    },

    // Auto-managed by scheduler: true when current WAT time is within
    // startTime-endTime AND today's date is within startDate-endDate range
    isActive: { type: Boolean, default: false },

    notes: { type: String },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Emergency activation tracking (per-shift)
    emergencyActivated: { type: Boolean, default: false },
    emergencyActivatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    emergencyActivatedAt: { type: Date },
  },
  { timestamps: true }
);

WorkShiftSchema.index({ userId: 1 });
WorkShiftSchema.index({ startDate: 1, endDate: 1 });
WorkShiftSchema.index({ status: 1 });
WorkShiftSchema.index({ isActive: 1 });

module.exports = mongoose.model('WorkShift', WorkShiftSchema);
