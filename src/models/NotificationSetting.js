const mongoose = require('mongoose');

const NotificationSettingSchema = new mongoose.Schema(
  {
    disableSms: { type: Boolean, default: false },
    disableEmail: { type: Boolean, default: false },
    disableWhatsapp: { type: Boolean, default: false },
    disableInApp: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('NotificationSetting', NotificationSettingSchema);
