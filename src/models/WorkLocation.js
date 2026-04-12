const mongoose = require('mongoose');

/**
 * Stores the single official work location used for geo-fenced clock-in/out.
 * Only one document is kept (upserted); multiple branches can be added later.
 */
const WorkLocationSchema = new mongoose.Schema(
  {
    name: { type: String, default: 'Main Branch' },
    googleMapsLink: { type: String },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    /** Allowed radius in meters. Default 10 m per spec. */
    radiusMeters: { type: Number, default: 10, min: 1, max: 5000 },
    /** When false, geofencing is disabled and clock-in/out is unrestricted. */
    enabled: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WorkLocation', WorkLocationSchema);
