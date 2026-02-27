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
const calculateOrderPricing = (items, pickupFee = 0, deliveryFee = 0, discount = 0) => {
  const subtotal = items.reduce((acc, item) => {
    return acc + (item.unitPrice || 0) * item.quantity;
  }, 0);

  const taxRate = 0.075; // 7.5% tax
  const tax = subtotal * taxRate;
  const total = subtotal + pickupFee + deliveryFee - discount + tax;

  return {
    subtotal,
    pickupFee,
    deliveryFee,
    discount,
    tax: Math.round(tax * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
};

// Generate QR Code string
const generateQRCode = (orderNumber) => {
  return `RELUX-${orderNumber}-${Date.now()}`;
};

// Get current date in WAT (West Africa Time, UTC+1) as "YYYY-MM-DD"
const getTodayWAT = () => {
  const now = new Date();
  const watOffset = 1 * 60; // WAT = UTC+1 in minutes
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const watMs = utcMs + watOffset * 60000;
  return new Date(watMs).toISOString().slice(0, 10);
};

// Get current date and time in WAT as { dateStr: "YYYY-MM-DD", timeStr: "HH:MM" }
const getNowWAT = () => {
  const now = new Date();
  const watOffset = 1 * 60;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const watMs = utcMs + watOffset * 60000;
  const watDate = new Date(watMs);

  const dateStr = watDate.toISOString().slice(0, 10);
  const hours = String(watDate.getHours()).padStart(2, '0');
  const minutes = String(watDate.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${minutes}`;

  return { dateStr, timeStr };
};

module.exports = {
  generateOTP,
  splitName,
  sendTokenResponse,
  calculateOrderPricing,
  generateQRCode,
  getTodayWAT,
  getNowWAT,
};
