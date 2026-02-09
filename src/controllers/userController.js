const User = require('../models/User.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get all users
// @route   GET /api/v1/users
// @access  Private (Admin/Manager)
exports.getUsers = asyncHandler(async (req, res, next) => {
  let query = {};

  // Filter by role if provided
  if (req.query.role) {
    query.role = req.query.role;
  }

  // Filter by active status
  if (req.query.isActive !== undefined) {
    query.isActive = req.query.isActive === 'true';
  }

  // Search by name, phone or email
  if (req.query.search) {
    query.$or = [
      { name: { $regex: req.query.search, $options: 'i' } },
      { phone: { $regex: req.query.search, $options: 'i' } },
      { email: { $regex: req.query.search, $options: 'i' } },
    ];
  }

  // Pagination
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await User.countDocuments(query);

  const users = await User.find(query)
    .select('-password')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Users fetched successfully',
    data: { users },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get single user
// @route   GET /api/v1/users/:id
// @access  Private (Admin/Manager)
exports.getUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id).select('-password');

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'User fetched successfully',
    data: { user },
  });
});

// @desc    Create staff user
// @route   POST /api/v1/users/staff
// @access  Private (Admin/Manager)
exports.createStaff = asyncHandler(async (req, res, next) => {
  const { name, email, phone, password, staffRole } = req.body;

  // Check if user already exists
  const existingUser = await User.findOne({ phone });
  if (existingUser) {
    return next(new AppError('Phone number already registered', 400));
  }

  // Create staff user
  const user = await User.create({
    name,
    email,
    phone,
    password,
    role: 'staff',
    staffRole,
  });

  // Remove password from response
  user.password = undefined;

  res.status(201).json({
    success: true,
    message: 'Staff created successfully',
    data: { user },
  });
});

// @desc    Update user
// @route   PUT /api/v1/users/:id
// @access  Private (Admin/Manager)
exports.updateUser = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    email: req.body.email,
    role: req.body.role,
    staffRole: req.body.staffRole,
    isActive: req.body.isActive,
  };

  // Remove undefined fields
  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const user = await User.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  }).select('-password');

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'User updated successfully',
    data: { user },
  });
});

// @desc    Deactivate user
// @route   PUT /api/v1/users/:id/deactivate
// @access  Private (Admin/Manager)
exports.deactivateUser = asyncHandler(async (req, res, next) => {
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isActive: false },
    { new: true }
  ).select('-password');

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'User deactivated successfully',
    data: { user },
  });
});

// @desc    Delete user
// @route   DELETE /api/v1/users/:id
// @access  Private (Admin/Manager)
exports.deleteUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // Prevent deleting yourself
  if (user._id.toString() === req.user.id) {
    return next(new AppError('You cannot delete your own account', 400));
  }

  await user.deleteOne();

  res.status(200).json({
    success: true,
    message: 'User deleted successfully',
    data: {},
  });
});
