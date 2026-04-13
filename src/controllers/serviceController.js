const Service = require('../models/Service.js');
const ServiceCategory = require('../models/ServiceCategory.js');
const ServiceLevelConfig = require('../models/ServiceLevelConfig.js');
const PickupWindow = require('../models/PickupWindow.js');
const DeliveryZone = require('../models/DeliveryZone.js');
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

  const services = await Service.find(query).sort({ position: 1, createdAt: 1 });

  // Enrich each service with its active categories
  const serviceIds = services.map((s) => s._id);
  const categories = await ServiceCategory.find({
    serviceId: { $in: serviceIds },
    active: true,
  }).sort('name');

  const enriched = services.map((s) => {
    const obj = s.toObject();
    obj.id = obj._id.toString();
    obj.categories = categories
      .filter((c) => c.serviceId.toString() === s._id.toString())
      .map((c) => {
        const cObj = c.toObject();
        cObj.id = cObj._id.toString();
        return cObj;
      });
    return obj;
  });

  res.status(200).json({
    success: true,
    message: 'Services fetched successfully',
    data: { services: enriched },
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

  // Place new service at the bottom of the list
  const last = await Service.findOne({}).sort({ position: -1 }).select('position');
  const position = last ? last.position + 1 : 0;

  const service = await Service.create({ name, description, icon, position });

  res.status(201).json({
    success: true,
    message: 'Service created successfully',
    data: { service },
  });
});

// @desc    Reorder services
// @route   PUT /api/v1/services/reorder
// @access  Private (Admin/Manager)
exports.reorderServices = asyncHandler(async (req, res, next) => {
  const { order } = req.body; // [{ id, position }, ...]

  if (!Array.isArray(order) || order.length === 0) {
    return next(new AppError('order must be a non-empty array', 400));
  }

  // Validate no duplicate positions
  const positions = order.map((o) => o.position);
  if (new Set(positions).size !== positions.length) {
    return next(new AppError('Duplicate positions in reorder request', 400));
  }

  await Service.bulkWrite(
    order.map(({ id, position }) => ({
      updateOne: {
        filter: { _id: id },
        update: { $set: { position } },
      },
    }))
  );

  // Return updated list in order
  const services = await Service.find({}).sort({ position: 1, createdAt: 1 });
  res.status(200).json({
    success: true,
    message: 'Services reordered',
    data: { services },
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

  const deletedPosition = service.position;
  await ServiceCategory.deleteMany({ serviceId: service._id });
  await service.deleteOne();

  // Re-compact: shift all services that were after the deleted one down by 1
  await Service.updateMany({ position: { $gt: deletedPosition } }, { $inc: { position: -1 } });

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

// ============================================================================
// ALL CATEGORIES (flat routes without serviceId)
// ============================================================================

// @desc    Get all service categories
// @route   GET /api/v1/services/categories
// @access  Private
exports.getAllCategories = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.active !== undefined) {
    query.active = req.query.active === 'true';
  }
  if (req.query.serviceId) {
    query.serviceId = req.query.serviceId;
  }

  const categories = await ServiceCategory.find(query).sort('name').populate('serviceId', 'name');

  res.status(200).json({
    success: true,
    message: 'Categories fetched successfully',
    data: { categories },
  });
});

// @desc    Create service category (flat route)
// @route   POST /api/v1/services/categories
// @access  Private (Admin/Manager)
exports.createCategoryFlat = asyncHandler(async (req, res, next) => {
  const { serviceId, name, basePrice, unit, icon } = req.body;

  if (serviceId) {
    const service = await Service.findById(serviceId);
    if (!service) {
      return next(new AppError('Service not found', 404));
    }
  }

  const category = await ServiceCategory.create({
    serviceId,
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

// @desc    Update service category (flat route)
// @route   PUT /api/v1/services/categories/:id
// @access  Private (Admin/Manager)
exports.updateCategoryFlat = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    basePrice: req.body.basePrice,
    unit: req.body.unit,
    icon: req.body.icon,
    active: req.body.active,
    serviceId: req.body.serviceId,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const category = await ServiceCategory.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!category) {
    return next(new AppError('Service category not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Service category updated successfully',
    data: { category },
  });
});

// @desc    Delete service category (flat route)
// @route   DELETE /api/v1/services/categories/:id
// @access  Private (Admin)
exports.deleteCategoryFlat = asyncHandler(async (req, res, next) => {
  const category = await ServiceCategory.findByIdAndDelete(req.params.id);

  if (!category) {
    return next(new AppError('Service category not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Service category deleted successfully',
    data: {},
  });
});

// ============================================================================
// SERVICE LEVELS
// ============================================================================

// @desc    Get all service levels
// @route   GET /api/v1/services/levels
// @access  Private
exports.getServiceLevels = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.active !== undefined) {
    query.active = req.query.active === 'true';
  }

  const levels = await ServiceLevelConfig.find(query).sort('displayOrder');

  res.status(200).json({
    success: true,
    message: 'Service levels fetched successfully',
    data: { levels },
  });
});

// @desc    Create service level
// @route   POST /api/v1/services/levels
// @access  Private (Admin/Manager)
exports.createServiceLevel = asyncHandler(async (req, res, next) => {
  const { name, code, multiplier, description, turnaroundTime, displayOrder } = req.body;

  const level = await ServiceLevelConfig.create({
    name,
    code,
    multiplier,
    description,
    turnaroundTime,
    displayOrder,
  });

  res.status(201).json({
    success: true,
    message: 'Service level created successfully',
    data: { level },
  });
});

// @desc    Update service level
// @route   PUT /api/v1/services/levels/:id
// @access  Private (Admin/Manager)
exports.updateServiceLevel = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    code: req.body.code,
    multiplier: req.body.multiplier,
    description: req.body.description,
    turnaroundTime: req.body.turnaroundTime,
    displayOrder: req.body.displayOrder,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const level = await ServiceLevelConfig.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!level) {
    return next(new AppError('Service level not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Service level updated successfully',
    data: { level },
  });
});

// @desc    Delete service level
// @route   DELETE /api/v1/services/levels/:id
// @access  Private (Admin)
exports.deleteServiceLevel = asyncHandler(async (req, res, next) => {
  const level = await ServiceLevelConfig.findById(req.params.id);

  if (!level) {
    return next(new AppError('Service level not found', 404));
  }

  await level.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Service level deleted successfully',
    data: {},
  });
});

// ============================================================================
// PICKUP WINDOWS
// ============================================================================

// @desc    Get all pickup windows
// @route   GET /api/v1/services/pickup-windows
// @access  Private
exports.getPickupWindows = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.active !== undefined) {
    query.active = req.query.active === 'true';
  }

  const windows = await PickupWindow.find(query).sort('startHour');

  res.status(200).json({
    success: true,
    message: 'Pickup windows fetched successfully',
    data: { windows },
  });
});

// @desc    Create pickup window
// @route   POST /api/v1/services/pickup-windows
// @access  Private (Admin/Manager)
exports.createPickupWindow = asyncHandler(async (req, res, next) => {
  const { dayOfWeek, startTime, endTime, baseFee, rushFee } = req.body;

  const window = await PickupWindow.create({
    dayOfWeek,
    startTime,
    endTime,
    baseFee,
    rushFee,
  });

  res.status(201).json({
    success: true,
    message: 'Pickup window created successfully',
    data: { window },
  });
});

// @desc    Update pickup window
// @route   PUT /api/v1/services/pickup-windows/:id
// @access  Private (Admin/Manager)
exports.updatePickupWindow = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    dayOfWeek: req.body.dayOfWeek,
    startTime: req.body.startTime,
    endTime: req.body.endTime,
    baseFee: req.body.baseFee,
    rushFee: req.body.rushFee,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const window = await PickupWindow.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!window) {
    return next(new AppError('Pickup window not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Pickup window updated successfully',
    data: { window },
  });
});

// @desc    Delete pickup window
// @route   DELETE /api/v1/services/pickup-windows/:id
// @access  Private (Admin)
exports.deletePickupWindow = asyncHandler(async (req, res, next) => {
  const window = await PickupWindow.findById(req.params.id);

  if (!window) {
    return next(new AppError('Pickup window not found', 404));
  }

  await window.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Pickup window deleted successfully',
    data: {},
  });
});

// ============================================================================
// DELIVERY ZONES
// ============================================================================

// @desc    Get all delivery zones
// @route   GET /api/v1/services/delivery-zones
// @access  Private
exports.getDeliveryZones = asyncHandler(async (req, res, next) => {
  let query = {};
  if (req.query.active !== undefined) {
    query.active = req.query.active === 'true';
  }

  const zones = await DeliveryZone.find(query).sort('name');

  res.status(200).json({
    success: true,
    message: 'Delivery zones fetched successfully',
    data: { zones },
  });
});

// @desc    Create delivery zone
// @route   POST /api/v1/services/delivery-zones
// @access  Private (Admin/Manager)
exports.createDeliveryZone = asyncHandler(async (req, res, next) => {
  const { name, areas, fee, estimatedTime } = req.body;

  const zone = await DeliveryZone.create({
    name,
    areas,
    fee,
    estimatedTime,
  });

  res.status(201).json({
    success: true,
    message: 'Delivery zone created successfully',
    data: { zone },
  });
});

// @desc    Update delivery zone
// @route   PUT /api/v1/services/delivery-zones/:id
// @access  Private (Admin/Manager)
exports.updateDeliveryZone = asyncHandler(async (req, res, next) => {
  const fieldsToUpdate = {
    name: req.body.name,
    areas: req.body.areas,
    fee: req.body.fee,
    estimatedTime: req.body.estimatedTime,
    active: req.body.active,
  };

  Object.keys(fieldsToUpdate).forEach(
    (key) => fieldsToUpdate[key] === undefined && delete fieldsToUpdate[key]
  );

  const zone = await DeliveryZone.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
    new: true,
    runValidators: true,
  });

  if (!zone) {
    return next(new AppError('Delivery zone not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Delivery zone updated successfully',
    data: { zone },
  });
});

// @desc    Delete delivery zone
// @route   DELETE /api/v1/services/delivery-zones/:id
// @access  Private (Admin)
exports.deleteDeliveryZone = asyncHandler(async (req, res, next) => {
  const zone = await DeliveryZone.findById(req.params.id);

  if (!zone) {
    return next(new AppError('Delivery zone not found', 404));
  }

  await zone.deleteOne();

  res.status(200).json({
    success: true,
    message: 'Delivery zone deleted successfully',
    data: {},
  });
});
