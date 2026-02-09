const mongoose = require('mongoose');

const NotificationPreferenceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
    channels: [{ type: String, enum: ['in_app', 'sms', 'email', 'whatsapp'] }],
    types: [{ type: String, enum: ['order_created', 'order_status_updated', 'order_due_soon', 'site_announcement', 'chat_message'] }],
    muteAll: { type: Boolean, default: false },
    quietHoursStart: { type: String },
    quietHoursEnd: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('NotificationPreference', NotificationPreferenceSchema);
