const mongoose = require('mongoose');

// Distributed lock for interval jobs.
//
// Deliberately in MongoDB rather than Redis: no new dependency, and unlike a
// PM2 instance-id check it also holds across separate containers or hosts —
// two containers each have a worker 0.
//
// _id is the job name. The holder renews `expiresAt` on every tick; if it dies,
// the lease lapses and another process can take over.
const JobLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    owner: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    acquiredAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('JobLock', JobLockSchema);
