// Generate OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Split a "name" string into firstName / lastName
const splitName = (name) => {
  if (!name) return { firstName: '', lastName: '' };
  const parts = name.trim().split(/\s+/);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || '',
  };
};

// Send token response
const sendTokenResponse = async (user, statusCode, res) => {
  const token = user.generateAuthToken();
  const { getRolePermissionsFromDB } = require('./rolePermissions.js');

  const options = {
    expires: new Date(
      Date.now() + parseInt(process.env.JWT_COOKIE_EXPIRE || 30) * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
  };

  if (process.env.NODE_ENV === 'production') {
    options.secure = true;
  }

  // Remove password from output
  user.password = undefined;

  // Build a plain object so we can add firstName/lastName for the frontend
  const userObj = user.toObject ? user.toObject() : { ...user };
  const { firstName, lastName } = splitName(userObj.name);
  userObj.firstName = firstName;
  userObj.lastName = lastName;
  // Normalize id field
  if (userObj._id && !userObj.id) userObj.id = userObj._id.toString();

  // Add permissions based on role (DB-first, with fallback to hardcoded defaults)
  userObj.permissions = await getRolePermissionsFromDB(userObj.role);

  res.status(statusCode).cookie('token', token, options).json({
    success: true,
    message: 'Login successful',
    data: {
      token,
      user: userObj,
    },
  });
};

// Calculate order pricing
// serviceFee  = surcharge for EXPRESS / PREMIUM service levels
// addOnsFee   = stain removal, fragrance, etc.
const calculateOrderPricing = (items, pickupFee = 0, deliveryFee = 0, discount = 0, serviceFee = 0, addOnsFee = 0) => {
  const subtotal = items.reduce((acc, item) => {
    return acc + (item.unitPrice || 0) * item.quantity;
  }, 0);

  const total = subtotal + serviceFee + pickupFee + deliveryFee + addOnsFee - discount;

  return {
    subtotal,
    serviceFee,
    pickupFee,
    deliveryFee,
    addOnsFee,
    discount,
    tax: 0,
    total: Math.max(0, Math.round(total * 100) / 100),
  };
};

// Generate QR Code string
const generateQRCode = (orderNumber) => {
  return `RELUX-${orderNumber}-${Date.now()}`;
};

// WAT is UTC+1 all year — West Africa Time observes no daylight saving, so a
// fixed offset is correct rather than a convenience.
const WAT_OFFSET_MS = 60 * 60 * 1000;

// Shift the epoch forward by the WAT offset, so reading the result with the
// UTC accessors yields WAT wall-clock. Everything below reads via toISOString()
// and never getHours()/getDate(), which makes these independent of the host
// timezone — the previous versions added getTimezoneOffset() to an epoch that
// was already UTC (a double shift) and then read local hours off the result,
// so they were only correct while the container happened to run on TZ=UTC.
const watWallClock = (ms = Date.now()) => new Date(ms + WAT_OFFSET_MS);

// Get current date in WAT (West Africa Time, UTC+1) as "YYYY-MM-DD"
const getTodayWAT = () => watWallClock().toISOString().slice(0, 10);

// Get current date and time in WAT as { dateStr: "YYYY-MM-DD", timeStr: "HH:MM" }
const getNowWAT = () => {
  const iso = watWallClock().toISOString();
  return { dateStr: iso.slice(0, 10), timeStr: iso.slice(11, 16) };
};

// Return the WAT calendar date string ("YYYY-MM-DD") for any Date object
const getWATDateStr = (date) => watWallClock(date.getTime()).toISOString().slice(0, 10);

// Cap proposedClockOut to 23:59:59 WAT of the clock-in day.
// Both arguments must be Date objects. Returns a Date.
const capToEndOfWATDay = (clockIn, proposedClockOut) => {
  const dayStr   = getWATDateStr(new Date(clockIn));
  const endOfDay = new Date(`${dayStr}T23:59:59+01:00`); // = 22:59:59 UTC
  return proposedClockOut > endOfDay ? endOfDay : proposedClockOut;
};

// ─── Canonical revenue definition ────────────────────────────────────────────
// /orders/dashboard-stats matched on `paymentStatus`, /admin/dashboard matched on
// `payment.status`, and only one of them excluded cancelled orders — so the two
// dashboards reported different revenue for the same day. Every aggregate that
// means "money we took" must build its $match from this.
const paidOrderMatch = () => ({
  paymentStatus: 'paid',
  status: { $nin: ['cancelled'] },
});

// Revenue amount for one order. Orders written before `pricing` was introduced
// carry only `total`, so the fallback is required or they sum as null.
const orderRevenueField = () => ({ $ifNull: ['$pricing.total', '$total'] });

// ─── WAT day/month boundaries ────────────────────────────────────────────────
// The business runs on WAT (UTC+1). Reporting previously mixed three different
// notions of "a day": exportController anchored to UTC, the dashboards used
// setHours() in whatever timezone the container happened to run in, and only the
// shift scheduler used WAT. Roughly an hour of orders landed on the wrong day.
// These are the single definition every report should use.

// Start of a WAT calendar day ("YYYY-MM-DD") as a UTC Date
const watDayStart = (dateStr) => new Date(`${dateStr}T00:00:00.000+01:00`);

// End of a WAT calendar day ("YYYY-MM-DD") as a UTC Date
const watDayEnd = (dateStr) => new Date(`${dateStr}T23:59:59.999+01:00`);

// Start of today in WAT
const startOfTodayWAT = () => watDayStart(getTodayWAT());

// Start of the WAT day `days` days ago
const startOfDaysAgoWAT = (days) => {
  const d = new Date(startOfTodayWAT().getTime() - days * 24 * 60 * 60 * 1000);
  return watDayStart(getWATDateStr(d));
};

// Start of the current WAT month
const startOfMonthWAT = () => watDayStart(`${getTodayWAT().slice(0, 7)}-01`);

// Start of the current WAT week (weeks run Sunday → Saturday)
const startOfWeekWAT = () => {
  // Midday avoids any DST/offset edge when reading the weekday back out
  const weekday = new Date(`${getTodayWAT()}T12:00:00+01:00`).getUTCDay();
  return startOfDaysAgoWAT(weekday);
};

module.exports = {
  generateOTP,
  splitName,
  sendTokenResponse,
  calculateOrderPricing,
  generateQRCode,
  getTodayWAT,
  getNowWAT,
  getWATDateStr,
  capToEndOfWATDay,
  paidOrderMatch,
  orderRevenueField,
  watDayStart,
  watDayEnd,
  startOfTodayWAT,
  startOfDaysAgoWAT,
  startOfMonthWAT,
  startOfWeekWAT,
};
