const mongoose = require('mongoose');

// Default duration in minutes per order status stage.
// These are used to compute stageDeadlineAt when an order transitions to that status.
// Stages without a configured duration (e.g. 'ready', 'pending') have no deadline.
const StageDurationSettingSchema = new mongoose.Schema(
  {
    confirmed: { type: Number, default: 15 },          // 15 min to accept/act
    'picked-up': { type: Number, default: 90 },        // 1.5 hr after pickup
    in_progress: { type: Number, default: 180 },       // 3 hr processing
    washing: { type: Number, default: 240 },           // 4 hr washing
    ironing: { type: Number, default: 90 },            // 1.5 hr ironing
    'out-for-delivery': { type: Number, default: 120 }, // 2 hr delivery window
    // 'ready', 'pending', 'delivered', 'completed', 'cancelled' — no countdown
  },
  { timestamps: true }
);

module.exports = mongoose.model('StageDurationSetting', StageDurationSettingSchema);
