const Role = require('../models/Role.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get all roles
// @route   GET /api/v1/roles
// @access  Private (Admin)
exports.getRoles = asyncHandler(async (req, res, next) => {
  const roles = await Role.find().sort('name');

  res.status(200).json({
    success: true,
    message: 'Roles fetched successfully',
    data: { roles },
  });
});

// @desc    Get single role
// @route   GET /api/v1/roles/:id
// @access  Private (Admin)
exports.getRole = asyncHandler(async (req, res, next) => {
  const role = await Role.findById(req.params.id);

  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Role fetched successfully',
    data: { role },
  });
});

// @desc    Create role
// @route   POST /api/v1/roles
// @access  Private (Admin)
exports.createRole = asyncHandler(async (req, res, next) => {
  const { name, permissions } = req.body;

  const existing = await Role.findOne({ name });
  if (existing) {
    return next(new AppError('Role name already exists', 400));
  }

  const role = await Role.create({ name, permissions });

  res.status(201).json({
    success: true,
    message: 'Role created successfully',
    data: { role },
  });
});

// @desc    Update role
// @route   PUT /api/v1/roles/:id
// @access  Private (Admin)
exports.updateRole = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    permissions: req.body.permissions,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const role = await Role.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Role updated successfully',
    data: { role },
  });
});

// @desc    Delete role
// @route   DELETE /api/v1/roles/:id
// @access  Private (Admin)
exports.deleteRole = asyncHandler(async (req, res, next) => {
  const role = await Role.findById(req.params.id);

  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  await role.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Role deleted successfully',
    data: {},
  });
});
