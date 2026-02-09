const mongoose = require('mongoose');

const StaffCompensationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    payType: { type: String, enum: ['hourly', 'monthly'], default: 'hourly' },
    hourlyRate: { type: Number, default: 0 },
    overtimeRate: { type: Number, default: 0 },
    monthlySalary: { type: Number, default: 0 },
    bonusPerOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StaffCompensation', StaffCompensationSchema);
