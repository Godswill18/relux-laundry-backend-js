const Customer = require('../models/Customer.js');

// Ensure a Customer document exists for the given User and link them.
// Idempotent — safe to call on every login/register/request.
const ensureCustomer = async (user) => {
  if (user.customerId) return user;

  // Try to find existing Customer by phone or email
  let customer;
  if (user.phone) customer = await Customer.findOne({ phone: user.phone });
  if (!customer && user.email) customer = await Customer.findOne({ email: user.email });

  if (!customer) {
    customer = await Customer.create({
      name: user.name,
      phone: user.phone || undefined,
      email: user.email || undefined,
      status: 'active',
    });
  }

  user.customerId = customer._id;
  await user.save({ validateBeforeSave: false });
  return user;
};

module.exports = ensureCustomer;
