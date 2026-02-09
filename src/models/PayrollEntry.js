const mongoose = require('mongoose');

const PayrollEntrySchema = new mongoose.Schema(
  {
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollPeriod', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    baseHours: { type: Number, default: 0 },
    overtimeHours: { type: Number, default: 0 },
    hourlyRate: { type: Number, default: 0 },
    overtimeRate: { type: Number, default: 0 },
    bonuses: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    totalPay: { type: Number, default: 0 },
    attendanceCount: { type: Number, default: 0 },
    lateCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

PayrollEntrySchema.index({ periodId: 1, userId: 1 }, { unique: true });
PayrollEntrySchema.index({ userId: 1 });

module.exports = mongoose.model('PayrollEntry', PayrollEntrySchema);
