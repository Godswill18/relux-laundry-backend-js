const mongoose = require('mongoose');

// Global marketing campaigns shown in the customer app (one document per
// campaign key). Controlled only by the Superadmin (developer role); every
// customer sees the same state. See controllers/campaignController.js.
const CampaignSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // e.g. 'anniversary'
    name: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    // Optional window: outside it the campaign is off even when enabled.
    startsAt: { type: Date },
    endsAt: { type: Date },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CampaignSetting', CampaignSettingSchema);
