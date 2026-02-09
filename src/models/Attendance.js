const mongoose = require('mongoose');

const AttendanceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkShift' },
    clockInAt: { type: Date, required: true },
    clockOutAt: { type: Date },
    source: { type: String, enum: ['app', 'qr'], default: 'app' },
    status: { type: String, enum: ['present', 'late', 'absent'], default: 'present' },
    ipAddress: { type: String },
    deviceId: { type: String },
    geoLat: { type: Number },
    geoLng: { type: Number },
  },
  { timestamps: true }
);

AttendanceSchema.index({ userId: 1, clockInAt: -1 });
AttendanceSchema.index({ shiftId: 1 });

module.exports = mongoose.model('Attendance', AttendanceSchema);
