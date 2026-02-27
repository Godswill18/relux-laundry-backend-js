const Role = require('../models/Role.js');
const User = require('../models/User.js');
const AuditLog = require('../models/AuditLog.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get all roles (auto-seeds defaults on first call when DB is empty)
// @route   GET /api/v1/roles
// @access  Private (Admin, Manager)
exports.getRoles = asyncHandler(async (req, res, next) => {
  const count = await Role.countDocuments();

  if (count === 0) {
    const { DEFAULT_ROLE_PERMISSIONS } = require('../utils/rolePermissions.js');
    const seeds = Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([name, permissions]) => ({
      name,
      permissions,
    }));
    await Role.insertMany(seeds);
  }

  const roles = await Role.find().sort('name');

  res.status(200).json({
    success: true,
    message: 'Roles fetched successfully',
    data: { roles },
  });
});

// @desc    Get single role
// @route   GET /api/v1/roles/:id
// @access  Private (Admin, Manager)
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

// @desc    Update role permissions
// @route   PUT /api/v1/roles/:id
// @access  Private (Admin)
exports.updateRole = asyncHandler(async (req, res, next) => {
  const role = await Role.findById(req.params.id);

  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  // Admin role permissions are locked — block UI edits
  if (role.name === 'admin') {
    return next(new AppError('Admin role permissions cannot be modified', 403));
  }

  const oldPermissions = [...role.permissions];

  if (req.body.permissions !== undefined) role.permissions = req.body.permissions;
  if (req.body.description !== undefined) role.description = req.body.description;
  if (req.body.name !== undefined) role.name = req.body.name;

  await role.save();

  // Bump jwtVersion for all users with this role so they must re-login immediately
  await User.updateMany({ role: role.name }, { $inc: { jwtVersion: 1 } });

  // Audit trail
  await AuditLog.create({
    actorUserId: req.user.id,
    action: 'ROLE_PERMISSIONS_UPDATED',
    targetType: 'Role',
    targetId: role._id.toString(),
    before: { permissions: oldPermissions },
    after: { permissions: role.permissions },
  });

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

// @desc    Get users assigned to a role
// @route   GET /api/v1/roles/:id/users
// @access  Private (Admin, Manager)
exports.getRoleUsers = asyncHandler(async (req, res, next) => {
  const role = await Role.findById(req.params.id);

  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  const users = await User.find({ role: role.name }).select(
    'name email phone role staffRole isActive createdAt'
  );

  res.status(200).json({
    success: true,
    message: 'Role users fetched successfully',
    data: { users },
  });
});

// @desc    Assign a user to a role
// @route   PATCH /api/v1/roles/:id/assign
// @access  Private (Admin)
exports.assignUserToRole = asyncHandler(async (req, res, next) => {
  const { userId } = req.body;

  if (!userId) {
    return next(new AppError('userId is required', 400));
  }

  const role = await Role.findById(req.params.id);
  if (!role) {
    return next(new AppError('Role not found', 404));
  }

  const user = await User.findById(userId);
  if (!user) {
    return next(new AppError('User not found', 404));
  }

  const oldRole = user.role;

  // Update role and bump jwtVersion — next request with old JWT will get 401
  await User.findByIdAndUpdate(userId, { role: role.name, $inc: { jwtVersion: 1 } });

  // Audit trail
  await AuditLog.create({
    actorUserId: req.user.id,
    action: 'ROLE_ASSIGNED',
    targetType: 'User',
    targetId: userId,
    before: { role: oldRole },
    after: { role: role.name },
  });

  res.status(200).json({
    success: true,
    message: `User assigned to '${role.name}' role successfully`,
    data: {},
  });
});
