const Service = require('../models/Service.js');
const ServiceCategory = require('../models/ServiceCategory.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');

// @desc    Get all services
// @route   GET /api/v1/services
// @access  Private
exports.getServices = asyncHandler(async (req, res, next) => {
  let query = {};

  if (req.query.active !== undefined) {
    query.active = req.query.active === 'true';
  }

  const services = await Service.find(query).sort('name');

  res.status(200).json({
    success: true,
    message: 'Services fetched successfully',
    data: { services },
  });
});

// @desc    Get single service
// @route   GET /api/v1/services/:id
// @access  Private
exports.getService = asyncHandler(async (req, res, next) => {
  const service = await Service.findById(req.params.id);

  if (!service) {
    return next(new AppError('Service not found', 404));
  }

  const categories = await ServiceCategory.find({ serviceId: service._id, active: true });

  res.status(200).json({
    success: true,
    message: 'Service fetched successfully',
    data: { service, categories },
  });
});

// @desc    Create service
// @route   POST /api/v1/services
// @access  Private (Admin/Manager)
exports.createService = asyncHandler(async (req, res, next) => {
  const { name, description, icon } = req.body;

  const existing = await Service.findOne({ name });
  if (existing) {
    return next(new AppError('Service name already exists', 400));
  }

  const service = await Service.create({ name, description, icon });

  res.status(201).json({
    success: true,
    message: 'Service created successfully',
    data: { service },
  });
});

// @desc    Update service
// @route   PUT /api/v1/services/:id
// @access  Private (Admin/Manager)
exports.updateService = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    description: req.body.description,
    icon: req.body.icon,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const service = await Service.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!service) {
    return next(new AppError('Service not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Service updated successfully',
    data: { service },
  });
});

// @desc    Delete service
// @route   DELETE /api/v1/services/:id
// @access  Private (Admin)
exports.deleteService = asyncHandler(async (req, res, next) => {
  const service = await Service.findById(req.params.id);

  if (!service) {
    return next(new AppError('Service not found', 404));
  }

  await ServiceCategory.deleteMany({ serviceId: service._id });
  await service.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Service deleted successfully',
    data: {},
  });
});

// @desc    Get categories for a service
// @route   GET /api/v1/services/:serviceId/categories
// @access  Private
exports.getServiceCategories = asyncHandler(async (req, res, next) => {
  const service = await Service.findById(req.params.serviceId);

  if (!service) {
    return next(new AppError('Service not found', 404));
  }

  let query = { serviceId: req.params.serviceId };

  if (req.query.active !== undefined) {
    query.active = req.query.active === 'true';
  }

  const categories = await ServiceCategory.find(query).sort('name');

  res.status(200).json({
    success: true,
    message: 'Service categories fetched successfully',
    data: { categories },
  });
});

// @desc    Create service category
// @route   POST /api/v1/services/:serviceId/categories
// @access  Private (Admin/Manager)
exports.createServiceCategory = asyncHandler(async (req, res, next) => {
  const service = await Service.findById(req.params.serviceId);

  if (!service) {
    return next(new AppError('Service not found', 404));
  }

  const { name, basePrice, unit, icon } = req.body;

  const category = await ServiceCategory.create({
    serviceId: req.params.serviceId,
    name,
    basePrice,
    unit,
    icon,
  });

  res.status(201).json({
    success: true,
    message: 'Service category created successfully',
    data: { category },
  });
});

// @desc    Update service category
// @route   PUT /api/v1/services/:serviceId/categories/:id
// @access  Private (Admin/Manager)
exports.updateServiceCategory = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    basePrice: req.body.basePrice,
    unit: req.body.unit,
    icon: req.body.icon,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const category = await ServiceCategory.findOneAndUpdate(
    { _id: req.params.id, serviceId: req.params.serviceId },
    fieldsToUpdate,
    { new: true, runValidators: true }
  );

  if (!category) {
    return next(new AppError('Service category not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Service category updated successfully',
    data: { category },
  });
});

// @desc    Delete service category
// @route   DELETE /api/v1/services/:serviceId/categories/:id
// @access  Private (Admin)
exports.deleteServiceCategory = asyncHandler(async (req, res, next) => {
  const category = await ServiceCategory.findOneAndDelete({
    _id: req.params.id,
    serviceId: req.params.serviceId,
  });

  if (!category) {
    return next(new AppError('Service category not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Service category deleted successfully',
    data: {},
  });
});
