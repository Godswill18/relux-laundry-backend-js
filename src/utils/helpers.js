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
const sendTokenResponse = (user, statusCode, res) => {
  const token = user.generateAuthToken();

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

module.exports = {
  generateOTP,
  splitName,
  sendTokenResponse,
  calculateOrderPricing,
  generateQRCode,
};
