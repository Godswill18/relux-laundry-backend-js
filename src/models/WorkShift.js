const mongoose = require('mongoose');

const WorkShiftSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    title: { type: String },
    notes: { type: String },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

WorkShiftSchema.index({ userId: 1 });
WorkShiftSchema.index({ startAt: 1 });

module.exports = mongoose.model('WorkShift', WorkShiftSchema);
