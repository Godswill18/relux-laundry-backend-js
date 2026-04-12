/**
 * Geo-fence helper utilities
 * Uses the Haversine formula for accurate short-distance calculations.
 */

const EARTH_RADIUS_M = 6_371_000; // metres

/**
 * Calculate the great-circle distance (metres) between two GPS coordinates.
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Parse latitude and longitude from common Google Maps URL formats.
 *
 * Supported patterns:
 *   https://www.google.com/maps/@6.5244,3.3792,15z
 *   https://www.google.com/maps/place/Name/@6.5244,3.3792,15z
 *   https://maps.google.com/maps?q=6.5244,3.3792
 *   https://www.google.com/maps?q=6.5244,3.3792
 *   https://maps.google.com/?q=6.5244,3.3792
 *   https://www.google.com/maps/search/?api=1&query=6.5244,3.3792
 *   Raw "6.5244,3.3792"
 *
 * Returns { lat, lng } or null if parsing fails.
 */
function parseGoogleMapsLink(input) {
  if (!input) return null;

  const str = input.trim();

  // 1. @lat,lng,zoom — most common share format
  const atMatch = str.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atMatch) {
    const lat = parseFloat(atMatch[1]);
    const lng = parseFloat(atMatch[2]);
    if (isValidCoords(lat, lng)) return { lat, lng };
  }

  // 2. ?q=lat,lng or &query=lat,lng
  const qMatch = str.match(/[?&](?:q|query)=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (qMatch) {
    const lat = parseFloat(qMatch[1]);
    const lng = parseFloat(qMatch[2]);
    if (isValidCoords(lat, lng)) return { lat, lng };
  }

  // 3. Raw "lat,lng" string
  const rawMatch = str.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
  if (rawMatch) {
    const lat = parseFloat(rawMatch[1]);
    const lng = parseFloat(rawMatch[2]);
    if (isValidCoords(lat, lng)) return { lat, lng };
  }

  return null;
}

function isValidCoords(lat, lng) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    !isNaN(lat) &&
    !isNaN(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Validate that the provided coordinates are within the work location radius.
 * Returns { allowed, distance, reason } where:
 *   allowed  — true if inside radius (or geofencing disabled)
 *   distance — distance in metres from work location (null if unknown)
 *   reason   — human-readable rejection reason (null if allowed)
 */
async function validateGeofence(staffLat, staffLng, accuracy) {
  const WorkLocation = require('../models/WorkLocation.js');

  const location = await WorkLocation.findOne().lean();

  // No location configured — allow but flag
  if (!location) {
    return { allowed: true, distance: null, reason: null, geofenceConfigured: false };
  }

  // Geofencing is disabled by admin
  if (!location.enabled) {
    return { allowed: true, distance: null, reason: null, geofenceConfigured: true };
  }

  // Validate inputs
  if (staffLat == null || staffLng == null || isNaN(staffLat) || isNaN(staffLng)) {
    return { allowed: false, distance: null, reason: 'Valid GPS coordinates are required', geofenceConfigured: true };
  }

  // Reject very low accuracy readings (> 100 m accuracy radius is unreliable)
  const MAX_ACCEPTABLE_ACCURACY = 100; // metres
  if (accuracy != null && !isNaN(accuracy) && accuracy > MAX_ACCEPTABLE_ACCURACY) {
    return {
      allowed: false,
      distance: null,
      reason: `GPS accuracy is too low (${Math.round(accuracy)} m). Move to an open area and try again.`,
      geofenceConfigured: true,
    };
  }

  const distance = haversineDistance(location.lat, location.lng, staffLat, staffLng);
  const radius = location.radiusMeters ?? 10;

  if (distance > radius) {
    return {
      allowed: false,
      distance: Math.round(distance),
      reason: `You are ${Math.round(distance)} m from the work location. Must be within ${radius} m to clock in/out.`,
      geofenceConfigured: true,
    };
  }

  return { allowed: true, distance: Math.round(distance), reason: null, geofenceConfigured: true };
}

module.exports = { haversineDistance, parseGoogleMapsLink, validateGeofence, isValidCoords };
