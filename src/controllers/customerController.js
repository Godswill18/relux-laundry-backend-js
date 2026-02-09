const Customer = require('../models/Customer.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get all customers
// @route   GET /api/v1/customers
// @access  Private (Admin/Manager/Staff)
exports.getCustomers = asyncHandler(async (req, res, next) => {
  let query = {};

  if (req.query.status) {
    query.status = req.query.status;
  }

  if (req.query.search) {
    query.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { phone: { $regex: req.query.search, $options: 'i' } },
      { email: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await Customer.countDocuments(query);

  const customers = await Customer.find(query)
    .populate('loyaltyTierId', 'name rank')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Customers fetched successfully',
    data: { customers },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single customer
// @route   GET /api/v1/customers/:id
// @access  Private (Admin/Manager/Staff)
exports.getCustomer = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.params.id)
    .populate('loyaltyTierId', 'name rank multiplierPercent');

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Customer fetched successfully',
    data: { customer },
  });
});

// @desc    Create customer
// @route   POST /api/v1/customers
// @access  Private (Admin/Manager/Staff)
exports.createCustomer = asyncHandler(async (req, res, next) => {
  const { name, phone, email, address, city, dateOfBirth, photoUrl } = req.body;

  if (phone) {
    const existing = await Customer.findOne({ phone });
    if (existing) {
      return next(new AppError('Phone number already registered', 400));
    }
  }

  if (email) {
    const existing = await Customer.findOne({ email });
    if (existing) {
      return next(new AppError('Email already registered', 400));
    }
  }

  const customer = await Customer.create({
    name,
    phone,
    email,
    address,
    city,
    dateOfBirth,
    photoUrl,
  });

  res.status(201).json({
    success: true,
    message: 'Customer created successfully',
    data: { customer },
  });
});

// @desc    Update customer
// @route   PUT /api/v1/customers/:id
// @access  Private (Admin/Manager)
exports.updateCustomer = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    phone: req.body.phone,
    email: req.body.email,
    address: req.body.address,
    city: req.body.city,
    dateOfBirth: req.body.dateOfBirth,
    photoUrl: req.body.photoUrl,
    status: req.body.status,
    loyaltyTierId: req.body.loyaltyTierId,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const customer = await Customer.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Customer updated successfully',
    data: { customer },
  });
});

// @desc    Get my customer profile
// @route   GET /api/v1/customers/me
// @access  Private
exports.getMyProfile = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findById(req.user.customerId)
    .populate('loyaltyTierId', 'name rank multiplierPercent');

  if (!customer) {
    return next(new AppError('Customer profile not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Profile fetched successfully',
    data: { customer },
  });
});

// @desc    Update my customer profile
// @route   PUT /api/v1/customers/me
// @access  Private
exports.updateMyProfile = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    email: req.body.email,
    address: req.body.address,
    city: req.body.city,
    dateOfBirth: req.body.dateOfBirth,
    photoUrl: req.body.photoUrl,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const customer = await Customer.findByIdAndUpdate(req.user.customerId, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!customer) {
    return next(new AppError('Customer profile not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    data: { customer },
  });
});

// @desc    Suspend customer
// @route   PUT /api/v1/customers/:id/suspend
// @access  Private (Admin/Manager)
exports.suspendCustomer = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { status: 'suspended' },
    { new: true }
  );

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Customer suspended successfully',
    data: { customer },
  });
});

// @desc    Activate customer
// @route   PUT /api/v1/customers/:id/activate
// @access  Private (Admin/Manager)
exports.activateCustomer = asyncHandler(async (req, res, next) => {
  const customer = await Customer.findByIdAndUpdate(
    req.params.id,
    { status: 'active' },
    { new: true }
  );

  if (!customer) {
    return next(new AppError('Customer not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Customer activated successfully',
    data: { customer },
  });
});
