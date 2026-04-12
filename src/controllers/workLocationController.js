const WorkLocation = require('../models/WorkLocation.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { parseGoogleMapsLink, isValidCoords } = require('../utils/geofenceHelper.js');

// @desc    Get current work location setting
// @route   GET /api/v1/work-location
// @access  Private
exports.getWorkLocation = asyncHandler(async (req, res) => {
  const location = await WorkLocation.findOne().lean();
  res.status(200).json({
    success: true,
    data: { location: location || null },
  });
});

// @desc    Save / update work location
// @route   PUT /api/v1/work-location
// @access  Private (Admin/Manager)
exports.saveWorkLocation = asyncHandler(async (req, res, next) => {
  const { name, googleMapsLink, lat, lng, radiusMeters, enabled } = req.body;

  let resolvedLat = lat != null ? Number(lat) : null;
  let resolvedLng = lng != null ? Number(lng) : null;

  // Auto-parse from Google Maps link if explicit coords not provided
  if ((resolvedLat == null || resolvedLng == null) && googleMapsLink) {
    const parsed = parseGoogleMapsLink(googleMapsLink);
    if (!parsed) {
      return next(
        new AppError(
          'Could not extract coordinates from the Google Maps link. ' +
          'Use a full link (e.g. https://www.google.com/maps/@6.5244,3.3792,15z) or enter coordinates directly.',
          400
        )
      );
    }
    resolvedLat = parsed.lat;
    resolvedLng = parsed.lng;
  }

  if (!isValidCoords(resolvedLat, resolvedLng)) {
    return next(new AppError('Valid latitude and longitude are required.', 400));
  }

  const fields = {
    lat: resolvedLat,
    lng: resolvedLng,
    updatedBy: req.user.id,
  };
  if (name !== undefined)         fields.name = name;
  if (googleMapsLink !== undefined) fields.googleMapsLink = googleMapsLink;
  if (radiusMeters !== undefined) fields.radiusMeters = Number(radiusMeters);
  if (enabled !== undefined)      fields.enabled = Boolean(enabled);

  const location = await WorkLocation.findOneAndUpdate(
    {},
    { $set: fields },
    { new: true, upsert: true, runValidators: true }
  );

  res.status(200).json({
    success: true,
    message: 'Work location saved successfully',
    data: { location },
  });
});

// @desc    Parse Google Maps link (preview — no save)
// @route   POST /api/v1/work-location/parse-link
// @access  Private (Admin/Manager)
exports.parseMapsLink = asyncHandler(async (req, res, next) => {
  const { googleMapsLink } = req.body;
  if (!googleMapsLink) return next(new AppError('googleMapsLink is required', 400));

  const coords = parseGoogleMapsLink(googleMapsLink);
  if (!coords) {
    return next(
      new AppError(
        'Could not parse coordinates from this link. ' +
        'Make sure it is a full Google Maps URL containing @lat,lng or ?q=lat,lng.',
        400
      )
    );
  }

  res.status(200).json({
    success: true,
    data: { lat: coords.lat, lng: coords.lng },
  });
});
