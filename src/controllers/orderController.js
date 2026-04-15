const Order = require('../models/Order.js');
const OrderItem = require('../models/OrderItem.js');
const OrderMedia = require('../models/OrderMedia.js');
const Customer = require('../models/Customer.js');
const ServiceLevelConfig = require('../models/ServiceLevelConfig.js');
const Addon = require('../models/Addon.js');
const Wallet = require('../models/Wallet.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const Referral = require('../models/Referral.js');
const ReferralSetting = require('../models/ReferralSetting.js');
const StageDurationSetting = require('../models/StageDurationSetting.js');
const LoyaltyLedger = require('../models/LoyaltyLedger.js');
const LoyaltySetting = require('../models/LoyaltySetting.js');
const User = require('../models/User.js');
const ServiceCategory = require('../models/ServiceCategory.js');
const LoyaltyTier = require('../models/LoyaltyTier.js');
const PromoCode = require('../models/PromoCode.js');
const PromoRedemption = require('../models/PromoRedemption.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const ERROR_CODES = require('../utils/errorCodes.js');
const { calculateOrderPricing, generateQRCode } = require('../utils/helpers.js');
const notify = require('../utils/notify.js');

// Statuses that have a countdown timer
const TIMED_STAGES = new Set(['confirmed', 'picked-up', 'in_progress', 'washing', 'ironing', 'out-for-delivery']);

// Fallback durations (minutes) used when StageDurationSetting has no DB document yet
const DEFAULT_STAGE_DURATIONS = {
  'confirmed':          15,
  'picked-up':          90,
  'in_progress':        180,
  'washing':            240,
  'ironing':            90,
  'out-for-delivery':   120,
};

/**
 * Returns { stageDeadlineAt, stageDurationMinutes } for the given status.
 * Always resolves — uses DB settings if available, falls back to hardcoded defaults.
 */
async function computeStageDeadline(status) {
  if (!TIMED_STAGES.has(status)) return { stageDeadlineAt: null, stageDurationMinutes: null };
  const durations = await StageDurationSetting.findOne().lean();
  const minutes = (durations && durations[status]) ? durations[status] : DEFAULT_STAGE_DURATIONS[status];
  if (!minutes || minutes <= 0) return { stageDeadlineAt: null, stageDurationMinutes: null };
  return {
    stageDurationMinutes: minutes,
    stageDeadlineAt: new Date(Date.now() + minutes * 60 * 1000),
  };
}

// Care-type multipliers — single source of truth on the backend
const CARE_TYPE_MULTIPLIERS = {
  'wash-fold': 1,
  'wash-only': 1,
  'iron-only': 0.6,
  'wash-iron': 1.5,
};

// ─── Referral auto-qualification helper ──────────────────────────────────────
// Called after an order reaches the trigger status (completed or paid).
// Checks every referral setting and credits wallet + loyalty points when earned.
async function processReferralReward(order, triggerStatus, io) {
  const settings = await ReferralSetting.findOne().sort('-createdAt').lean();
  if (!settings || !settings.enabled) return;

  // Only fire on the configured qualifying status
  const qualifyOn = (settings.qualifyOnStatus || 'completed').toLowerCase();
  if (triggerStatus.toLowerCase() !== qualifyOn) return;

  // order.customer is a User._id — look up the User directly
  const refereeUser = await User.findById(order.customer).select('_id customerId name').lean();
  if (!refereeUser) return;

  // Find the pending/qualified referral for this referee
  const referral = await Referral.findOne({
    refereeUserId: refereeUser._id,
    status: { $in: ['pending', 'qualified'] },
    rewardCredited: false,
  });
  if (!referral) return;

  // Check maxRewardsPerReferrer
  if (settings.maxRewardsPerReferrer && settings.maxRewardsPerReferrer > 0) {
    const alreadyRewarded = await Referral.countDocuments({
      referrerUserId: referral.referrerUserId,
      status: 'rewarded',
    });
    if (alreadyRewarded >= settings.maxRewardsPerReferrer) return;
  }

  // Check minOrderCount — count orders that have reached the qualifying status
  const minCount = settings.minOrderCount || 1;
  const qualifiedOrdersQuery = qualifyOn === 'paid'
    ? { customer: order.customer, paymentStatus: 'paid' }
    : { customer: order.customer, status: 'completed' };
  const qualifiedOrdersCount = await Order.countDocuments(qualifiedOrdersQuery);
  if (qualifiedOrdersCount < minCount) return;

  // Check minOrderAmount
  if (settings.minOrderAmount && settings.minOrderAmount > 0) {
    if ((order.total || 0) < settings.minOrderAmount) return;
  }

  // Resolve reward amounts from live settings
  const referrerRewardAmount  = settings.referrerRewardAmount  ?? 0;
  const refereeRewardAmount   = settings.refereeRewardAmount   ?? 0;
  const referrerLoyaltyPoints = settings.referrerLoyaltyPoints ?? 0;
  const refereeLoyaltyPoints  = settings.refereeLoyaltyPoints  ?? 0;

  // --- Credit referrer wallet ---
  const referrerUser = await User.findById(referral.referrerUserId).select('_id customerId name').lean();
  if (referrerUser && referrerUser.customerId) {
    if (referrerRewardAmount > 0) {
      let referrerWallet = await Wallet.findOne({ customerId: referrerUser.customerId });
      if (!referrerWallet) referrerWallet = await Wallet.create({ customerId: referrerUser.customerId, balance: 0 });
      referrerWallet.balance += referrerRewardAmount;
      await referrerWallet.save();
      await WalletTransaction.create({
        walletId: referrerWallet._id,
        customerId: referrerUser.customerId,
        type: 'credit',
        amount: referrerRewardAmount,
        reason: `Referral reward for ${refereeUser.name || 'a new customer'}`,
        balanceAfter: referrerWallet.balance,
      });
      if (io) {
        io.to(`user-${referrerUser.customerId}`).emit('wallet:balance-updated', {
          balance: referrerWallet.balance,
          transaction: { type: 'credit', amount: referrerRewardAmount, reason: `Referral reward` },
        });
        io.to(`user-${referrerUser.customerId}`).emit('referral:rewarded', {
          referralId: referral._id,
          amount: referrerRewardAmount,
          refereeName: refereeUser.name,
        });
      }
      await notify(io, {
        type: 'referral_rewarded',
        title: 'Referral Reward Received',
        body: `You earned ₦${referrerRewardAmount.toLocaleString()} for referring ${refereeUser.name || 'a new customer'}!`,
        customerId: String(referrerUser.customerId),
        metadata: { referralId: referral._id, amount: referrerRewardAmount },
      });
    }
    // --- Credit referrer loyalty points ---
    if (referrerLoyaltyPoints > 0) {
      await LoyaltyLedger.create({
        customerId: referrerUser.customerId,
        points: referrerLoyaltyPoints,
        type: 'earn',
        source: 'referral',
        referenceId: referral._id,
        reason: `Referral points bonus for referring ${refereeUser.name || 'a new customer'}`,
      });
      await Customer.findByIdAndUpdate(referrerUser.customerId, {
        $inc: { loyaltyPointsBalance: referrerLoyaltyPoints, loyaltyLifetimePoints: referrerLoyaltyPoints },
      });
    }
  }
  referral.rewardCredited = true;
  referral.rewardAmount = referrerRewardAmount;
  referral.referrerLoyaltyPoints = referrerLoyaltyPoints;

  // --- Credit referee wallet ---
  if (refereeUser.customerId) {
    if (refereeRewardAmount > 0) {
      let refereeWallet = await Wallet.findOne({ customerId: refereeUser.customerId });
      if (!refereeWallet) refereeWallet = await Wallet.create({ customerId: refereeUser.customerId, balance: 0 });
      refereeWallet.balance += refereeRewardAmount;
      await refereeWallet.save();
      await WalletTransaction.create({
        walletId: refereeWallet._id,
        customerId: refereeUser.customerId,
        type: 'credit',
        amount: refereeRewardAmount,
        reason: 'Welcome referral bonus',
        balanceAfter: refereeWallet.balance,
      });
      if (io) {
        io.to(`user-${refereeUser.customerId}`).emit('wallet:balance-updated', {
          balance: refereeWallet.balance,
          transaction: { type: 'credit', amount: refereeRewardAmount, reason: 'Welcome referral bonus' },
        });
      }
      await notify(io, {
        type: 'wallet_credited',
        title: 'Welcome Bonus Received',
        body: `₦${refereeRewardAmount.toLocaleString()} referral welcome bonus has been added to your wallet.`,
        customerId: String(refereeUser.customerId),
        metadata: { amount: refereeRewardAmount },
      });
    }
    // --- Credit referee loyalty points ---
    if (refereeLoyaltyPoints > 0) {
      await LoyaltyLedger.create({
        customerId: refereeUser.customerId,
        points: refereeLoyaltyPoints,
        type: 'earn',
        source: 'referral',
        referenceId: referral._id,
        reason: 'Welcome referral loyalty bonus',
      });
      await Customer.findByIdAndUpdate(refereeUser.customerId, {
        $inc: { loyaltyPointsBalance: refereeLoyaltyPoints, loyaltyLifetimePoints: refereeLoyaltyPoints },
      });
    }
  }
  referral.refereeRewardCredited = true;
  referral.refereeRewardAmount = refereeRewardAmount;
  referral.refereeLoyaltyPoints = refereeLoyaltyPoints;
  referral.status = 'rewarded';
  await referral.save();
}

// ─── Auto-award loyalty points when an order is completed / delivered ─────────
// Idempotent: uses atomic findOneAndUpdate + unique DB index to prevent duplicates.
async function awardOrderPoints(order, io) {
  if (order.loyaltyPointsAwarded) return;

  // Only award for orders linked to a real customer (not anonymous walk-ins)
  const customerUser = await User.findById(order.customer).select('customerId').lean();
  if (!customerUser?.customerId) return;
  const customerId = customerUser.customerId;

  // Load loyalty settings
  const settings = await LoyaltySetting.findOne().lean();
  if (!settings || !settings.enabled) return;

  // Get customer's tier multiplier
  const customer = await Customer.findById(customerId)
    .populate('loyaltyTierId', 'multiplierPercent')
    .lean();
  const tierMultiplier = customer?.loyaltyTierId?.multiplierPercent
    ? customer.loyaltyTierId.multiplierPercent / 100
    : 1;

  // Base points: pointsPerCurrency * order total * tier multiplier
  const orderAmount = order.pricing?.total || order.total || 0;
  let points = Math.floor(orderAmount * (settings.pointsPerCurrency || 1) * tierMultiplier);

  if (settings.maxPointsPerOrder && points > settings.maxPointsPerOrder) {
    points = settings.maxPointsPerOrder;
  }
  if (points <= 0) return;

  // Atomic claim — prevents race conditions and double-awarding
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, loyaltyPointsAwarded: { $ne: true } },
    { loyaltyPointsAwarded: true, 'pricing.loyaltyPointsEarned': points },
    { new: false }
  );
  if (!claimed) return; // Already awarded

  // Create ledger entry (unique index orderId+type is a second safety net)
  try {
    await LoyaltyLedger.create({
      customerId,
      orderId: order._id,
      points,
      type: 'earn',
      source: 'order',
      reason: `Points earned from Order #${order.orderNumber || order._id.toString().slice(-6).toUpperCase()}`,
    });
  } catch (e) {
    if (e.code === 11000) return; // Duplicate key — already in ledger
    throw e;
  }

  // Credit customer balance
  const updatedCustomer = await Customer.findByIdAndUpdate(
    customerId,
    { $inc: { loyaltyPointsBalance: points, loyaltyLifetimePoints: points } },
    { new: true }
  ).lean();

  // Tier upgrade check
  if (updatedCustomer) {
    const allTiers = await LoyaltyTier.find({ active: true }).sort('rank').lean();
    const eligible = allTiers.filter(t => t.pointsRequired <= (updatedCustomer.loyaltyLifetimePoints || 0)).pop();
    const currentTierId = updatedCustomer.loyaltyTierId?.toString();
    if (eligible && eligible._id.toString() !== currentTierId) {
      await Customer.findByIdAndUpdate(customerId, { loyaltyTierId: eligible._id });
    }
  }

  // Real-time update
  if (io) {
    io.to(`user-${customerId}`).emit('loyalty:points-earned', {
      points,
      balance: updatedCustomer?.loyaltyPointsBalance ?? 0,
      orderId: order._id,
      reason: `Points earned from order`,
    });
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Create new order (online or offline walk-in)
// @route   POST /api/v1/orders
// @access  Private
exports.createOrder = asyncHandler(async (req, res, next) => {
  const {
    serviceType,
    orderType,
    orderSource,
    walkInCustomer,
    items,
    pickupAddress,
    deliveryAddress,
    pickupDate,
    deliveryDate,
    scheduledPickupTime,
    specialInstructions,
    pricing,
    paymentMethod,
    customerId: bodyCustomerId,
    assignedStaff,
    serviceLevel,
    serviceLevelId,
    pickupMethod,
    rush,
    stainRemoval,
    fragrance,
    addons: addonsPayload,
    pickupFee: bodyPickupFee,
    discount: bodyDiscount,
    promoCode: bodyPromoCode,
  } = req.body;

  const isStaffRole = ['staff', 'admin', 'manager'].includes(req.user.role);
  // Auto-classify: staff/admin/manager always creates walk-in (offline); customers always create online
  const isOffline = isStaffRole;

  // Determine the customer for this order
  let orderCustomerId = null;
  let orderCustomerRefId = null;

  if (isOffline && isStaffRole) {
    // Offline walk-in order created by staff — no customer User account required
    // walkInCustomer.name and walkInCustomer.phone are used instead
    if (!walkInCustomer || !walkInCustomer.name) {
      return next(new AppError('Walk-in customer name is required for offline orders', 400));
    }
    // Use the staff member's own ID as a placeholder to satisfy the schema
    orderCustomerId = req.user.id;
  } else {
    // Online order
    orderCustomerId = req.user.id;
    orderCustomerRefId = req.user.customerId;

    if (bodyCustomerId && isStaffRole) {
      const customer = await Customer.findById(bodyCustomerId);
      if (!customer) {
        return next(new AppError('Customer not found', 404));
      }
      const customerUser = await User.findOne({ customerId: bodyCustomerId });
      orderCustomerId = customerUser ? customerUser._id : req.user.id;
      orderCustomerRefId = bodyCustomerId;
    }
  }

  // Validate that every item includes a serviceType
  if (Array.isArray(items) && items.length > 0) {
    const missing = items.find((item) => !item.serviceType);
    if (missing) {
      return next(new AppError(`Item "${missing.itemType || 'unknown'}" is missing a service type`, 400));
    }
  }

  // Recompute unitPrice from DB for every item — never trust frontend price
  let pricedItems = items || [];
  if (pricedItems.length > 0) {
    pricedItems = await Promise.all(
      pricedItems.map(async (item) => {
        if (!item.categoryId) return item; // walk-in items without a category pass through
        const category = await ServiceCategory.findById(item.categoryId).select('basePrice').lean();
        if (!category) return item; // unknown category — leave as-is
        const multiplier = CARE_TYPE_MULTIPLIERS[item.serviceType] ?? 1;
        const unitPrice = Math.round(category.basePrice * multiplier);
        return { ...item, unitPrice, total: unitPrice * (item.quantity || 1) };
      })
    );
  }

  // Service-level surcharge: look up percentage from DB (dynamic, admin-controlled)
  let resolvedServiceLevelId   = null;
  let resolvedServiceLevelName = serviceLevel || 'standard';
  let serviceLevelPct          = 0; // percentage adjustment, e.g. 20 = +20%

  if (serviceLevelId) {
    const slDoc = await ServiceLevelConfig.findById(serviceLevelId).lean();
    if (slDoc) {
      resolvedServiceLevelId   = slDoc._id;
      resolvedServiceLevelName = slDoc.name;
      serviceLevelPct          = slDoc.percentageAdjustment || 0;
    }
  } else if (serviceLevel) {
    // Fallback: match by name (case-insensitive) for backward compat
    const slDoc = await ServiceLevelConfig.findOne({
      name: { $regex: new RegExp(`^${serviceLevel}$`, 'i') },
    }).lean();
    if (slDoc) {
      resolvedServiceLevelId   = slDoc._id;
      resolvedServiceLevelName = slDoc.name;
      serviceLevelPct          = slDoc.percentageAdjustment || 0;
    }
  }

  const baseSubtotal = pricedItems.reduce((acc, item) => acc + (item.unitPrice || 0) * (item.quantity || 1), 0);
  const serviceFee   = Math.round(baseSubtotal * serviceLevelPct / 100 * 100) / 100;

  // Add-ons fee: resolve from DB — dynamic, admin-controlled
  let addOnsFee = 0;
  const resolvedAddons = [];
  if (Array.isArray(addonsPayload) && addonsPayload.length > 0) {
    for (const a of addonsPayload) {
      if (!a.addonId) continue;
      const addonDoc = await Addon.findById(a.addonId).lean();
      if (!addonDoc || !addonDoc.active) continue;
      const calculatedAmount = addonDoc.type === 'fixed'
        ? addonDoc.value
        : Math.round(baseSubtotal * addonDoc.value / 100);
      addOnsFee += calculatedAmount;
      resolvedAddons.push({
        addonId: addonDoc._id,
        name: addonDoc.name,
        type: addonDoc.type,
        value: addonDoc.value,
        calculatedAmount,
      });
    }
  }

  // pickupFee: frontend passes it at top-level or inside pricing object
  const resolvedPickupFee = bodyPickupFee || (pricing && pricing.pickupFee) || 0;
  const resolvedDeliveryFee = req.body.deliveryFee || (pricing && pricing.deliveryFee) || 0;
  // discount: promo + points reductions passed by frontend
  const resolvedDiscount = bodyDiscount != null ? bodyDiscount : (pricing && pricing.discount) || 0;

  // Always recalculate pricing from DB-verified item prices — ignore frontend total
  const orderPricing = calculateOrderPricing(
    pricedItems,
    resolvedPickupFee,
    resolvedDeliveryFee,
    resolvedDiscount,
    serviceFee,
    addOnsFee
  );

  // Create order
  const order = await Order.create({
    customer: orderCustomerId,
    customerId: orderCustomerRefId || undefined,
    orderSource: isOffline ? 'offline' : 'online',
    walkInCustomer: isOffline ? walkInCustomer : undefined,
    createdByStaff: isStaffRole ? req.user.id : undefined,
    createdByRole: req.user.role,
    serviceType,
    orderType: orderType || (isOffline ? 'walk-in' : undefined),
    items: pricedItems,
    pickupAddress: pickupAddress || undefined,
    deliveryAddress: deliveryAddress || undefined,
    // PICKUP: store pickup date; DELIVERY: store delivery date; DROP_OFF: no schedule
    pickupDate: pickupMethod && pickupMethod.toLowerCase() === 'pickup' ? pickupDate : undefined,
    deliveryDate: pickupMethod && pickupMethod.toLowerCase() === 'delivery' ? (deliveryDate || pickupDate) : undefined,
    scheduledPickupTime: pickupMethod && pickupMethod.toLowerCase() !== 'drop_off' ? scheduledPickupTime : undefined,
    specialInstructions,
    serviceLevel: resolvedServiceLevelName,
    serviceLevelId: resolvedServiceLevelId || undefined,
    serviceLevelName: resolvedServiceLevelName,
    serviceLevelPercentage: serviceLevelPct,
    pickupMethod: pickupMethod || undefined,
    rush: rush || false,
    stainRemoval: stainRemoval || false,
    fragrance: fragrance || false,
    addons: resolvedAddons,
    // Staff-created walk-in orders → auto-assigned + skip pending (go straight to confirmed)
    // Admin/manager-created and online orders → unassigned pending pool for staff to pick
    assignedStaff: (req.user.role === 'staff' && isOffline)
      ? req.user.id
      : (assignedStaff || undefined),
    status: (req.user.role === 'staff' && isOffline) ? 'confirmed' : 'pending',
    pricing: orderPricing,
    total: orderPricing.total,
    payment: {
      method: paymentMethod || 'cash',
      status: 'pending',
      amount: orderPricing.total,
    },
  });

  // Generate QR code
  order.qrCode = generateQRCode(order.orderNumber);
  await order.save();

  // Record promo code redemption (fire-and-forget — don't block the response)
  if (bodyPromoCode) {
    try {
      const promoDoc = await PromoCode.findOne({ code: bodyPromoCode.toUpperCase(), active: true });
      if (promoDoc) {
        await PromoRedemption.create({
          promoCodeId: promoDoc._id,
          orderId: order._id,
          customerId: orderCustomerRefId || null,
          amount: orderPricing.discount,
        });
      }
    } catch (err) {
      // Non-fatal: log but don't fail the order
      console.error('Promo redemption recording failed:', err.message);
    }
  }

  // Handle wallet payment if payment method is 'wallet'
  if (paymentMethod && paymentMethod.toLowerCase() === 'wallet') {
    // Get customer's wallet
    const wallet = await Wallet.findOne({ customerId: orderCustomerRefId });

    if (!wallet) {
      return next(new AppError('Wallet not found for this customer', 404, ERROR_CODES.NOT_FOUND));
    }

    // Validate sufficient balance
    if (wallet.balance < orderPricing.total) {
      return next(new AppError('Insufficient wallet balance', 400, ERROR_CODES.INSUFFICIENT_BALANCE));
    }

    // Deduct from wallet
    wallet.balance -= orderPricing.total;
    await wallet.save();

    // Create wallet transaction
    await WalletTransaction.create({
      walletId: wallet._id,
      customerId: orderCustomerRefId,
      type: 'debit',
      amount: orderPricing.total,
      reason: `Payment for order ${order.orderNumber}`,
      balanceAfter: wallet.balance,
      orderId: order._id,
    });

    // Mark payment as paid
    order.payment.status = 'paid';
    order.payment.paidAt = new Date();
    order.paymentStatus = 'paid';
    await order.save();

    // Auto-disburse referral reward if qualifyOnStatus is 'paid'
    await processReferralReward(order, 'paid', req.app.get('io'));

    // Emit Socket.io event for wallet update
    const io = req.app.get('io');
    if (io) {
      io.to(`user-${orderCustomerRefId}`).emit('wallet:balance-updated', {
        balance: wallet.balance,
        transaction: {
          type: 'debit',
          amount: orderPricing.total,
          reason: `Payment for order ${order.orderNumber}`,
        },
      });
    }
  }

  // Emit socket event for real-time update + notifications
  const io = req.app.get('io');
  if (io) {
    io.emit('order-created', order);
    io.to(`user-${orderCustomerRefId || orderCustomerId}`).emit('order:created', order);
  }

  // Notify admin room: new order
  await notify(io, {
    type: 'order_created',
    title: 'New Order Received',
    body: `Order ${order.orderNumber} has been placed${order.orderSource === 'online' ? ' online' : ' (walk-in)'}.`,
    room: 'admin',
    metadata: { orderId: order._id, orderNumber: order.orderNumber, total: order.total },
  });

  // Notify delivery agents: new order that requires pickup + delivery
  const needsDelivery = order.orderType === 'pickup-delivery' || !!order.deliveryAddress;
  if (needsDelivery) {
    await notify(io, {
      type: 'order_needs_pickup',
      title: '🚚 New Delivery Order',
      body: `Order ${order.orderNumber} requires pickup and delivery.`,
      room: 'delivery',
      metadata: { orderId: order._id, orderNumber: order.orderNumber },
    });
  }

  // Notify customer: order confirmed
  if (orderCustomerRefId || orderCustomerId) {
    await notify(io, {
      type: 'order_created',
      title: 'Order Confirmed',
      body: `Your order ${order.orderNumber} has been received and is being processed.`,
      customerId: String(orderCustomerRefId || orderCustomerId),
      metadata: { orderId: order._id, orderNumber: order.orderNumber },
    });
  }

  res.status(201).json({
    success: true,
    message: 'Order created successfully',
    data: { order },
  });
});

// @desc    Get all orders
// @route   GET /api/v1/orders
// @access  Private
// Query params (staff/admin):
//   ?status=pending
//   ?orderSource=online|offline
//   ?assignedStaff=me            → orders assigned to logged-in staff
//   ?unassigned=true             → pending orders with no staff assigned
//   ?tab=new|mine|offline        → convenience shorthand for staff tabs
exports.getOrders = asyncHandler(async (req, res, next) => {
  let query;

  // Customers only see their own orders
  if (req.user.role === 'customer') {
    query = { customer: req.user.id };
  } else {
    query = {};

    // --- Staff dashboard tab shortcuts ---
    if (req.query.tab === 'new') {
      // Unassigned online orders available to claim
      query.orderSource = 'online';
      query.assignedStaff = { $exists: false };
      query.status = { $in: ['pending', 'confirmed'] };
    } else if (req.query.tab === 'mine') {
      // Orders assigned to this staff member that are still active
      query.assignedStaff = req.user.id;
      query.status = { $nin: ['completed', 'delivered', 'cancelled'] };
    } else if (req.query.tab === 'offline') {
      // Offline walk-in orders created by this staff member
      query.orderSource = 'offline';
      if (req.user.role === 'staff') query.createdByStaff = req.user.id;
    } else if (req.query.tab === 'completed') {
      // All finished orders handled by this staff (assigned OR created)
      query.$or = [
        { assignedStaff: req.user.id },
        { createdByStaff: req.user.id },
      ];
      query.status = { $in: ['completed', 'delivered'] };
    } else if (req.query.statusTab) {
      // --- 11-status workflow tab (Admin & Staff pages) ---
      const st = req.query.statusTab;
      const isAdminRole = ['admin', 'manager', 'receptionist'].includes(req.user.role);

      if (st === 'pending') {
        query.status = 'pending';
        if (!isAdminRole) {
          // Staff see only the pickable pool: unassigned orders created by admin/manager OR online orders
          // Staff-created orders are auto-assigned at creation so they never land here,
          // but createdByRole filter ensures correctness even for edge cases
          query.assignedStaff = { $exists: false };
          query.$or = [
            { orderSource: 'online' },                                             // customer / app orders
            { createdByRole: { $in: ['admin', 'manager', 'receptionist'] } },      // admin-created walk-ins
          ];
        }
      } else {
        query.status = st;
        // Non-pending: all staff see ALL orders globally (full visibility).
        // When ?myOrders=true: filter to only orders this staff is involved with.
        if (!isAdminRole && req.query.myOrders === 'true') {
          const staffId = req.user.id;
          query.$or = [
            { assignedStaff: staffId },
            { pickupStaffId: staffId },
            { deliveredBy: staffId },
            { lastUpdatedById: staffId },
          ];
        }
      }
    } else {
      // Manual filters
      if (req.query.excludeCompleted === 'true') {
        query.status = { $nin: ['delivered', 'completed', 'cancelled'] };
      } else if (req.query.doneOnly === 'true') {
        query.status = { $in: ['delivered', 'completed'] };
      } else if (req.query.status) {
        query.status = req.query.status;
      }
      if (req.query.serviceType) query.serviceType = req.query.serviceType;
      if (req.query.customer) query.customer = req.query.customer;
      if (req.query.orderSource) query.orderSource = req.query.orderSource;

      if (req.query.assignedStaff === 'me') {
        query.assignedStaff = req.user.id;
      } else if (req.query.assignedStaff) {
        query.assignedStaff = req.query.assignedStaff;
      }

      if (req.query.unassigned === 'true') {
        query.assignedStaff = { $exists: false };
      }

      // Filter by who delivered
      if (req.query.deliveredBy === 'me') {
        query.deliveredBy = req.user.id;
      } else if (req.query.deliveredBy) {
        query.deliveredBy = req.query.deliveredBy;
      }
    }

    // Delivery-role: restrict to delivery-type orders only
    if (req.user.role === 'delivery') {
      query.$or = [
        { orderType: 'pickup-delivery' },
        { deliveryAddress: { $exists: true, $ne: null } },
      ];
    }
  }

  // Pagination
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 10;
  const startIndex = (page - 1) * limit;

  const total = await Order.countDocuments(query);

  const orders = await Order.find(query)
    .populate({
      path: 'customer',
      select: 'name phone email avatar customerId',
      populate: {
        path: 'customerId',
        select: 'loyaltyPointsBalance status loyaltyTierId',
        populate: { path: 'loyaltyTierId', select: 'name rank multiplierPercent' },
      },
    })
    .populate('assignedStaff', 'name phone staffRole email')
    .populate('pickupStaffId', 'name phone')
    .populate('deliveredBy', 'name phone')
    .populate('lastUpdatedById', 'name')
    .populate('serviceLevelId', 'name percentageAdjustment')
    .populate('statusHistory.updatedBy', 'name')
    .sort('-createdAt')
    .skip(startIndex)
    .limit(limit);

  res.status(200).json({
    success: true,
    message: 'Orders fetched successfully',
    data: { orders },
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

// @desc    Get staff-specific tab counts per status (11-workflow)
// @route   GET /api/v1/orders/staff-counts
// @access  Private (staff, admin, manager)
exports.getStaffCounts = asyncHandler(async (req, res) => {
  const staffId = req.user.id;
  // scope=all → total orders per status across all staff
  // scope=mine (default) → orders this staff is involved with
  const scope = req.query.scope || 'mine';

  const STATUSES = [
    'pending', 'confirmed', 'picked-up', 'in_progress',
    'washing', 'ironing', 'ready', 'out-for-delivery',
    'delivered', 'completed', 'cancelled',
  ];

  const results = await Promise.all(
    STATUSES.map((s) => {
      if (s === 'pending') {
        // Pending badge = pickable pool: unassigned admin/manager/online orders
        return Order.countDocuments({
          status: 'pending',
          assignedStaff: { $exists: false },
          $or: [
            { orderSource: 'online' },
            { createdByRole: { $in: ['admin', 'manager', 'receptionist'] } },
          ],
        });
      }
      if (scope === 'all') {
        // Global count — all orders at this status regardless of assignment
        return Order.countDocuments({ status: s });
      }
      // scope=mine: orders this staff is assigned to or has touched
      return Order.countDocuments({
        status: s,
        $or: [
          { assignedStaff: staffId },
          { pickupStaffId: staffId },
          { deliveredBy: staffId },
          { lastUpdatedById: staffId },
        ],
      });
    })
  );

  const byStatus = Object.fromEntries(STATUSES.map((s, i) => [s, results[i]]));

  res.status(200).json({
    success: true,
    data: byStatus,
  });
});

// @desc    Get order counts per status (admin view — all orders, no staff filter)
// @route   GET /api/v1/orders/counts
// @access  Private (staff, admin, manager)
exports.getOrderCounts = asyncHandler(async (req, res) => {
  const STATUSES = [
    'pending', 'confirmed', 'picked-up', 'in_progress',
    'washing', 'ironing', 'ready', 'out-for-delivery',
    'delivered', 'completed', 'cancelled',
  ];

  const results = await Promise.all(
    STATUSES.map((s) => Order.countDocuments({ status: s }))
  );

  const byStatus = Object.fromEntries(STATUSES.map((s, i) => [s, results[i]]));

  // Convenience totals
  const total      = results.reduce((a, b) => a + b, 0);
  const active     = STATUSES
    .filter((s) => !['delivered', 'completed', 'cancelled'].includes(s))
    .reduce((sum, s) => sum + byStatus[s], 0);

  res.status(200).json({
    success: true,
    data: { ...byStatus, total, active },
  });
});

// @desc    Get single order
// @route   GET /api/v1/orders/:id
// @access  Private
exports.getOrder = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id)
    .populate({
      path: 'customer',
      select: 'name phone email addresses avatar customerId',
      populate: {
        path: 'customerId',
        select: 'loyaltyPointsBalance status loyaltyTierId',
        populate: { path: 'loyaltyTierId', select: 'name rank multiplierPercent freePickup freeDelivery' },
      },
    })
    .populate('assignedStaff', 'name phone staffRole email avatar')
    .populate('serviceLevelId', 'name percentageAdjustment')
    .populate('statusHistory.updatedBy', 'name role')
    .populate('deliveryZoneId', 'name fee rushFee radiusKm')
    .populate('pickupWindowId', 'startTime endTime dayOfWeek baseFee');

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Check if user has access to this order
  if (
    req.user.role === 'customer' &&
    order.customer._id.toString() !== req.user.id
  ) {
    return next(new AppError('Not authorized to access this order', 403));
  }

  res.status(200).json({
    success: true,
    message: 'Order fetched successfully',
    data: { order },
  });
});

// @desc    Update order details (non-status fields)
// @route   PUT /api/v1/orders/:id
// @access  Private (Staff/Admin/Manager)
exports.updateOrder = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Customers cannot edit orders
  if (req.user.role === 'customer') {
    return next(new AppError('Not authorized to edit orders', 403));
  }

  // Block editing completed/delivered/cancelled orders
  if (['completed', 'delivered', 'cancelled'].includes(order.status)) {
    return next(new AppError('Cannot edit a completed, delivered, or cancelled order', 400));
  }

  const previousTotal = order.total || 0;
  const previousPaymentMethod = order.payment?.method;
  const previousPaymentStatus = order.paymentStatus;

  // ── Non-item fields ────────────────────────────────────────────────────────
  const scalarFields = [
    'serviceType', 'orderType', 'pickupAddress', 'deliveryAddress',
    'pickupDate', 'deliveryDate', 'scheduledPickupTime', 'specialInstructions',
    'serviceLevel', 'serviceLevelId', 'serviceLevelName', 'serviceLevelPercentage',
    'pickupMethod', 'rush', 'stainRemoval', 'fragrance',
    'notes', 'walkInCustomer', 'assignedStaff', 'paymentStatus',
  ];
  scalarFields.forEach((field) => {
    if (req.body[field] !== undefined) order[field] = req.body[field];
  });

  // Keep payment.status in sync when paymentStatus is updated
  if (req.body.paymentStatus !== undefined) {
    const syncMap = { unpaid: 'pending', paid: 'paid', partial: 'pending', refunded: 'refunded' };
    if (syncMap[req.body.paymentStatus]) order.payment.status = syncMap[req.body.paymentStatus];
  }

  // ── Items + price recalculation ────────────────────────────────────────────
  let newTotal = previousTotal;

  if (req.body.items !== undefined) {
    // Re-price every item from DB — never trust frontend prices
    const pricedItems = await Promise.all(
      req.body.items.map(async (item) => {
        if (!item.categoryId) return item;
        const category = await ServiceCategory.findById(item.categoryId).select('basePrice').lean();
        if (!category) return item;
        const MULTIPLIERS = { 'wash-fold': 1, 'wash-only': 1, 'iron-only': 0.6, 'wash-iron': 1.5 };
        const multiplier = MULTIPLIERS[item.serviceType] ?? 1;
        const unitPrice = Math.round(category.basePrice * multiplier);
        return { ...item, unitPrice, total: unitPrice * (item.quantity || 1) };
      })
    );
    order.items = pricedItems;

    // Recalculate full pricing — look up service level from DB
    const currentSLId = req.body.serviceLevelId || order.serviceLevelId;
    const currentSLName = req.body.serviceLevel || order.serviceLevel || 'standard';
    let updateSLPct = order.serviceLevelPercentage || 0;
    if (currentSLId) {
      const slDoc = await ServiceLevelConfig.findById(currentSLId).lean();
      if (slDoc) updateSLPct = slDoc.percentageAdjustment || 0;
    } else {
      const slDoc = await ServiceLevelConfig.findOne({
        name: { $regex: new RegExp(`^${currentSLName}$`, 'i') },
      }).lean();
      if (slDoc) updateSLPct = slDoc.percentageAdjustment || 0;
    }
    const baseSubtotal = pricedItems.reduce((acc, i) => acc + (i.unitPrice || 0) * (i.quantity || 1), 0);
    const serviceFee = Math.round(baseSubtotal * updateSLPct / 100 * 100) / 100;

    // Resolve add-ons fee from DB (or fall back to existing if not provided)
    let addOnsFee = 0;
    if (Array.isArray(req.body.addons)) {
      const addonsForUpdate = [];
      for (const a of req.body.addons) {
        if (!a.addonId) continue;
        const addonDoc = await Addon.findById(a.addonId).lean();
        if (!addonDoc || !addonDoc.active) continue;
        const base = pricedItems.reduce((acc, i) => acc + (i.unitPrice || 0) * (i.quantity || 1), 0);
        const calculatedAmount = addonDoc.type === 'fixed'
          ? addonDoc.value
          : Math.round(base * addonDoc.value / 100);
        addOnsFee += calculatedAmount;
        addonsForUpdate.push({
          addonId: addonDoc._id,
          name: addonDoc.name,
          type: addonDoc.type,
          value: addonDoc.value,
          calculatedAmount,
        });
      }
      order.addons = addonsForUpdate;
    } else {
      // No addons change — preserve existing add-ons fee from pricing
      addOnsFee = order.pricing?.addOnsFee || 0;
    }

    const pickupFee   = order.pricing?.pickupFee   || 0;
    const deliveryFee = order.pricing?.deliveryFee || 0;
    const discount    = order.pricing?.discount    || 0;

    const newPricing = calculateOrderPricing(pricedItems, pickupFee, deliveryFee, discount, serviceFee, addOnsFee);
    order.pricing = newPricing;
    order.total   = newPricing.total;
    newTotal      = newPricing.total;
  } else if (req.body.pricing && req.body.pricing.total !== undefined) {
    // Manual pricing override (no items change)
    order.pricing = { ...order.pricing, ...req.body.pricing };
    order.total   = req.body.pricing.total;
    newTotal      = req.body.pricing.total;
  }

  order.lastUpdatedById = req.user.id;

  // ── Price-difference handling + wallet refund ──────────────────────────────
  const difference = Math.round((previousTotal - newTotal) * 100) / 100; // positive = overpaid → refund
  let refundIssued = false;
  let refundAmount = 0;

  if (difference > 0 && previousPaymentStatus === 'paid' && previousPaymentMethod === 'wallet') {
    // Customer overpaid — refund the difference to their wallet
    const orderUser = await User.findById(order.customer).select('customerId').lean();
    if (orderUser?.customerId) {
      const wallet = await Wallet.findOne({ customerId: orderUser.customerId });
      if (wallet) {
        wallet.balance += difference;
        await wallet.save();
        await WalletTransaction.create({
          walletId: wallet._id,
          customerId: orderUser.customerId,
          type: 'credit',
          amount: difference,
          reason: `Order Adjustment Refund — ${order.orderNumber}`,
          balanceAfter: wallet.balance,
        });
        refundIssued = true;
        refundAmount = difference;

        // Reduce the recorded payment amount to match the new lower total
        order.payment.amount = newTotal;

        const io = req.app.get('io');
        if (io) {
          io.to(`user-${orderUser.customerId}`).emit('wallet:balance-updated', {
            balance: wallet.balance,
            transaction: { type: 'credit', amount: difference, reason: `Order Adjustment Refund` },
          });
        }
      }
    }
  } else if (difference < 0 && previousPaymentStatus === 'paid') {
    // New total is higher — keep payment.amount as what was actually paid, mark partial
    order.paymentStatus = 'partial';
    order.payment.status = 'pending';
    // payment.amount stays as previousTotal (what was actually paid — do NOT change it)
  }

  // ── Audit trail ────────────────────────────────────────────────────────────
  if (req.body.items !== undefined || (req.body.pricing && req.body.pricing.total !== undefined)) {
    order.editHistory.push({
      editedBy: req.user.id,
      previousTotal,
      newTotal,
      difference,
      refundIssued,
      refundAmount,
      notes: req.body.editNote || undefined,
    });
  }

  await order.save();

  await order.populate('customer', 'name phone email');
  await order.populate('assignedStaff', 'name phone staffRole');
  await order.populate('editHistory.editedBy', 'name role');

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:updated', {
      orderId: order._id,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.payment?.method,
      total: order.total,
    });
  }

  res.status(200).json({
    success: true,
    message: 'Order updated successfully',
    data: { order, priceDifference: difference, refundIssued, refundAmount },
  });
});

// @desc    Update order status
// @route   PUT /api/v1/orders/:id/status
// @access  Private (Staff/Admin)
exports.updateOrderStatus = asyncHandler(async (req, res, next) => {
  const { status, notes } = req.body;

  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (order.status === 'cancelled') {
    return next(new AppError('Cannot update status of a cancelled order', 400));
  }

  // Update status
  order.status = status;
  if (notes) order.notes = notes;

  // Track who last updated this order (for "Handled by" display)
  order.lastUpdatedById = req.user.id;

  // Track who picked up / delivered the order
  if (status === 'picked-up') {
    order.actualPickupDate = order.actualPickupDate || new Date();
    if (!order.pickupStaffId) order.pickupStaffId = req.user.id;
  }
  if (status === 'delivered') {
    order.actualDeliveryDate = order.actualDeliveryDate || new Date();
    order.deliveredBy = req.user.id;
  }

  // Compute stageDeadlineAt — always uses defaults if no DB document exists yet
  const { stageDeadlineAt, stageDurationMinutes } = await computeStageDeadline(status);
  // null clears the field in MongoDB; undefined is ignored by Mongoose save
  order.stageDeadlineAt     = stageDeadlineAt;
  order.stageDurationMinutes = stageDurationMinutes;

  // Add to status history
  order.statusHistory.push({
    status,
    updatedBy: req.user.id,
    notes,
  });

  await order.save();

  // Handle referral auto-qualification — respects all referral settings
  if (status) {
    await processReferralReward(order, status, req.app.get('io'));
  }

  // Auto-award loyalty points on completion or delivery
  if (['completed', 'delivered'].includes(status)) {
    await awardOrderPoints(order, req.app.get('io'));
  }

  // Emit socket event
  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order-status-updated', {
      orderId: order._id,
      status,
      notes,
      stageDeadlineAt,
      stageDurationMinutes,
    });
    // Global broadcast so all connected clients (delivery, staff, admin) get live updates
    io.emit('order:status-updated', {
      orderId: order._id,
      status,
      updatedById: String(req.user.id),
      updatedByName: req.user.name || '',
    });
    io.emit('order:timer-updated', {
      orderId: order._id,
      status,
      stageDeadlineAt,
      stageDurationMinutes,
    });
  }

  // Notify customer of status change
  {
    const orderCustomerId = order.customerId || (order.customer ? String(order.customer) : null);
    // Resolve customerId from User if only customer (User._id) is stored
    let resolvedCustomerId = orderCustomerId;
    if (!resolvedCustomerId && order.customer) {
      const orderUser = await User.findById(order.customer).select('customerId').lean();
      resolvedCustomerId = orderUser?.customerId ? String(orderUser.customerId) : null;
    }
    const statusLabels = {
      confirmed: 'confirmed', 'picked-up': 'picked up', in_progress: 'in progress',
      washing: 'being washed', ironing: 'being ironed', 'out-for-delivery': 'out for delivery',
      ready: 'ready for pickup', delivered: 'delivered', completed: 'completed',
      cancelled: 'cancelled',
    };
    const label = statusLabels[status] || status;
    if (resolvedCustomerId) {
      await notify(io, {
        type: 'order_status_updated',
        title: 'Order Update',
        body: `Your order ${order.orderNumber} is now ${label}.`,
        customerId: resolvedCustomerId,
        metadata: { orderId: order._id, orderNumber: order.orderNumber, status },
      });
    }
    // Notify admin room on cancellation
    if (status === 'cancelled') {
      await notify(io, {
        type: 'order_cancelled',
        title: 'Order Cancelled',
        body: `Order ${order.orderNumber} has been cancelled.`,
        room: 'admin',
        metadata: { orderId: order._id, orderNumber: order.orderNumber },
      });
    }

    // Notify delivery agents when an order is ready to be delivered
    if (status === 'ready') {
      await notify(io, {
        type: 'order_ready_for_delivery',
        title: '📦 Order Ready for Delivery',
        body: `Order ${order.orderNumber} has been processed and is ready for delivery.`,
        room: 'delivery',
        metadata: { orderId: order._id, orderNumber: order.orderNumber },
      });
    }
  }

  res.status(200).json({
    success: true,
    message: 'Order status updated successfully',
    data: { order },
  });
});

// @desc    Look up order by QR code (no status change — preview before confirming)
// @route   POST /api/v1/orders/lookup-by-qr
// @access  Private (Staff/Admin/Manager)
exports.lookupByQR = asyncHandler(async (req, res, next) => {
  const { qrCode } = req.body;

  if (!qrCode) {
    return next(new AppError('QR code is required', 400));
  }

  const order = await Order.findOne({ qrCode })
    .populate('customer', 'name phone email')
    .populate('assignedStaff', 'name')
    .populate('statusHistory.updatedBy', 'name');

  if (!order) {
    return next(new AppError('Invalid or unrecognized QR code', 404));
  }

  const isCancelled = order.status === 'cancelled';

  // Tell the frontend exactly what actions are permitted for this order.
  // An empty array means the UI must show no action buttons at all.
  const allowedActions = isCancelled
    ? []
    : ['updateStatus', 'updatePayment', 'assignStaff'];

  res.status(200).json({
    success: true,
    message: isCancelled ? 'This order has been cancelled' : 'Order found',
    data: { order, allowedActions, isCancelled },
  });
});

// @desc    Scan QR code to confirm delivery
// @route   POST /api/v1/orders/scan-delivery
// @access  Private (Staff/Admin/Manager)
exports.scanDelivery = asyncHandler(async (req, res, next) => {
  const { qrCode } = req.body;

  if (!qrCode) {
    return next(new AppError('QR code is required', 400));
  }

  const order = await Order.findOne({ qrCode })
    .populate('customer', 'name phone email')
    .populate('assignedStaff', 'name');

  if (!order) {
    return next(new AppError('Invalid or unrecognized QR code', 404));
  }

  if (['delivered', 'completed'].includes(order.status)) {
    return next(new AppError('This order has already been delivered', 400));
  }

  if (order.status === 'cancelled') {
    return next(new AppError('This order has been cancelled and cannot be delivered', 400));
  }

  // Only the assigned delivery staff (or admin/manager) can confirm delivery
  const isAdminRole = ['admin', 'manager'].includes(req.user.role);
  if (!isAdminRole && order.deliveredBy) {
    const assignedId = String(order.deliveredBy._id || order.deliveredBy);
    if (assignedId !== String(req.user.id)) {
      return next(new AppError('Only the assigned delivery staff can confirm this delivery', 403));
    }
  }

  order.status = 'delivered';
  order.actualDeliveryDate = new Date();
  order.deliveredBy = req.user.id;
  order.statusHistory.push({
    status: 'delivered',
    updatedBy: req.user.id,
    notes: 'Delivery confirmed via barcode scan',
    timestamp: new Date(),
  });

  await order.save();

  const io = req.app.get('io');

  // Auto-award loyalty points for scan delivery
  await awardOrderPoints(order, io);

  if (io) {
    io.to(`order-${order._id}`).emit('order-status-updated', {
      orderId: order._id,
      status: 'delivered',
    });
    io.emit('order:status-updated', { orderId: order._id, status: 'delivered' });
  }

  res.status(200).json({
    success: true,
    message: 'Order delivered successfully',
    data: { order },
  });
});

// @desc    Assign staff to order
// @route   PUT /api/v1/orders/:id/assign
// @access  Private (Admin)
exports.assignStaff = asyncHandler(async (req, res, next) => {
  const { staffId } = req.body;

  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { assignedStaff: staffId },
    { new: true, runValidators: true }
  ).populate('assignedStaff', 'name phone staffRole');

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Staff assigned successfully',
    data: { order },
  });
});

// @desc    Staff accepts/claims an unassigned online order
// @route   PATCH /api/v1/orders/:id/accept
// @access  Private (Staff/Admin/Manager)
exports.acceptOrder = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (order.assignedStaff) {
    return next(new AppError('This order has already been claimed by another staff member', 400));
  }

  // Only admin/manager-created and online (customer) orders are pickable
  // Staff-created orders are auto-assigned at creation
  if (order.createdByRole === 'staff') {
    return next(new AppError('Walk-in orders created by staff are automatically assigned and cannot be picked', 400));
  }

  if (['completed', 'cancelled', 'delivered'].includes(order.status)) {
    return next(new AppError('Cannot accept a completed or cancelled order', 400));
  }

  order.assignedStaff = req.user.id;
  order.status = 'confirmed';

  // Set stage countdown for the confirmed stage
  const { stageDeadlineAt: acceptDeadline, stageDurationMinutes: acceptDuration } = await computeStageDeadline('confirmed');
  order.stageDeadlineAt      = acceptDeadline;
  order.stageDurationMinutes = acceptDuration;

  order.statusHistory.push({
    status: 'confirmed',
    updatedBy: req.user.id,
    notes: `Order accepted by staff: ${req.user.name}`,
  });
  await order.save();

  await order.populate('assignedStaff', 'name phone staffRole');
  await order.populate('customer', 'name phone email');

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order-status-updated', {
      orderId: order._id,
      status: 'confirmed',
      assignedStaff: req.user.id,
      stageDeadlineAt: acceptDeadline,
      stageDurationMinutes: acceptDuration,
    });
    io.to(`user-${order.customer?._id || order.customer}`).emit('order:accepted', {
      orderId: order._id,
      orderNumber: order.orderNumber,
      staffName: req.user.name,
    });
    io.emit('order:timer-updated', {
      orderId: order._id,
      status: 'confirmed',
      stageDeadlineAt: acceptDeadline,
      stageDurationMinutes: acceptDuration,
    });
  }

  res.status(200).json({
    success: true,
    message: 'Order accepted successfully',
    data: { order },
  });
});

// @desc    Delivery staff claims an order for PICKUP (atomic lock)
// @route   PATCH /api/v1/orders/:id/accept-pickup
// @access  Private (delivery, admin, manager)
exports.acceptPickup = asyncHandler(async (req, res, next) => {
  // Atomic findOneAndUpdate prevents two staff claiming simultaneously
  const order = await Order.findOneAndUpdate(
    {
      _id: req.params.id,
      status: 'confirmed',
      pickupStaffId: { $exists: false },
    },
    {
      $set: { pickupStaffId: req.user.id },
    },
    { new: true }
  )
    .populate('customer', 'name phone email')
    .populate('pickupStaffId', 'name phone');

  if (!order) {
    // Either not found or already claimed
    const existing = await Order.findById(req.params.id).select('pickupStaffId status').lean();
    if (!existing) return next(new AppError('Order not found', 404));
    if (existing.pickupStaffId) return next(new AppError('This pickup has already been claimed by another staff member', 409));
    return next(new AppError('Order is not available for pickup', 400));
  }

  order.statusHistory.push({
    status: order.status,
    updatedBy: req.user.id,
    notes: `Pickup claimed by delivery staff: ${req.user.name}`,
  });
  await order.save();

  const io = req.app.get('io');
  if (io) {
    io.emit('order:pickup-claimed', {
      orderId: order._id,
      pickupStaffId: req.user.id,
      pickupStaffName: req.user.name,
    });
  }

  res.status(200).json({
    success: true,
    message: 'Pickup claimed successfully',
    data: { order },
  });
});

// @desc    Delivery staff claims an order for DELIVERY (atomic lock)
// @route   PATCH /api/v1/orders/:id/accept-delivery
// @access  Private (delivery, admin, manager)
exports.acceptDelivery = asyncHandler(async (req, res, next) => {
  // Atomic findOneAndUpdate prevents two staff claiming simultaneously
  const order = await Order.findOneAndUpdate(
    {
      _id: req.params.id,
      status: 'ready',
      deliveredBy: { $exists: false },
    },
    {
      $set: { deliveredBy: req.user.id, status: 'out-for-delivery' },
    },
    { new: true }
  )
    .populate('customer', 'name phone email')
    .populate('deliveredBy', 'name phone');

  if (!order) {
    const existing = await Order.findById(req.params.id).select('deliveredBy status').lean();
    if (!existing) return next(new AppError('Order not found', 404));
    if (existing.deliveredBy) return next(new AppError('This delivery has already been claimed by another staff member', 409));
    return next(new AppError('Order is not available for delivery', 400));
  }

  order.statusHistory.push({
    status: 'out-for-delivery',
    updatedBy: req.user.id,
    notes: `Delivery accepted and marked out-for-delivery by: ${req.user.name}`,
  });
  await order.save();

  const io = req.app.get('io');
  if (io) {
    io.emit('order:delivery-claimed', {
      orderId: order._id,
      deliveredBy: req.user.id,
      deliveryStaffName: req.user.name,
    });
    io.emit('order:status-updated', { orderId: order._id, status: 'out-for-delivery' });
  }

  res.status(200).json({
    success: true,
    message: 'Delivery claimed successfully',
    data: { order },
  });
});

// @desc    Confirm pickup via barcode scan → status: picked-up
// @route   POST /api/v1/orders/scan-pickup
// @access  Private (delivery, staff, admin, manager)
exports.scanPickup = asyncHandler(async (req, res, next) => {
  const { qrCode } = req.body;
  if (!qrCode) return next(new AppError('QR code is required', 400));

  const order = await Order.findOne({ qrCode })
    .populate('customer', 'name phone email')
    .populate('pickupStaffId', 'name');

  if (!order) return next(new AppError('Invalid or unrecognized QR code', 404));
  if (order.status === 'cancelled') return next(new AppError('This order has been cancelled', 400));
  if (!['confirmed', 'pending'].includes(order.status)) {
    return next(new AppError(`Cannot confirm pickup: order is currently "${order.status}"`, 400));
  }

  // Only the assigned pickup staff (or admin/manager) can scan
  const isAdminRole = ['admin', 'manager'].includes(req.user.role);
  if (!isAdminRole && order.pickupStaffId) {
    const assignedId = String(order.pickupStaffId._id || order.pickupStaffId);
    if (assignedId !== String(req.user.id)) {
      return next(new AppError('Only the assigned pickup staff can confirm this pickup', 403));
    }
  }

  order.status = 'picked-up';
  order.actualPickupDate = new Date();
  if (!order.pickupStaffId) order.pickupStaffId = req.user.id;
  order.statusHistory.push({
    status: 'picked-up',
    updatedBy: req.user.id,
    notes: 'Pickup confirmed via barcode scan',
    timestamp: new Date(),
  });
  await order.save();

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order-status-updated', { orderId: order._id, status: 'picked-up' });
    io.emit('order:status-updated', { orderId: order._id, status: 'picked-up' });
  }

  res.status(200).json({
    success: true,
    message: 'Order picked up successfully',
    data: { order },
  });
});

// @desc    Update payment status
// @route   PUT /api/v1/orders/:id/payment
// @access  Private (Staff/Admin)
exports.updatePayment = asyncHandler(async (req, res, next) => {
  const { status, method, transactionId } = req.body;

  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (order.status === 'cancelled') {
    return next(new AppError('Cannot update payment on a cancelled order', 400));
  }

  order.payment.status = status;
  if (method) order.payment.method = method;
  if (transactionId) order.payment.transactionId = transactionId;

  if (status === 'paid') {
    order.payment.paidAt = Date.now();
  }

  // Keep top-level paymentStatus in sync so normalisation on the frontend is consistent
  const paymentStatusMap = { pending: 'unpaid', paid: 'paid', failed: 'unpaid', refunded: 'refunded' };
  if (paymentStatusMap[status]) order.paymentStatus = paymentStatusMap[status];

  await order.save();

  // Handle referral auto-qualification for qualifyOnStatus: 'paid'
  if (status === 'paid') {
    await processReferralReward(order, 'paid', req.app.get('io'));
  }

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:updated', {
      orderId: order._id,
      paymentStatus: order.payment.status,
      paymentMethod: order.payment.method,
    });
  }

  res.status(200).json({
    success: true,
    message: 'Payment updated successfully',
    data: { order },
  });
});

// @desc    Pay remaining balance from customer wallet (for partial-payment orders)
// @route   POST /api/v1/orders/:id/pay-balance
// @access  Private (Staff/Admin/Manager)
exports.payBalanceFromWallet = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError('Order not found', 404));

  if (order.paymentStatus !== 'partial') {
    return next(new AppError('Order does not have a partial payment balance', 400));
  }

  // Balance due = new total − what was already paid
  const alreadyPaid = order.payment?.amount || 0;
  const balanceDue = Math.round((order.total - alreadyPaid) * 100) / 100;

  if (balanceDue <= 0) {
    return next(new AppError('No outstanding balance on this order', 400));
  }

  // Resolve customer wallet
  const orderUser = await User.findById(order.customer).select('customerId').lean();
  if (!orderUser?.customerId) {
    return next(new AppError('Customer wallet not found', 404));
  }

  const wallet = await Wallet.findOne({ customerId: orderUser.customerId });
  if (!wallet) return next(new AppError('Customer does not have a wallet', 404));

  if (wallet.balance < balanceDue) {
    return next(new AppError(
      `Insufficient wallet balance. Balance: ₦${wallet.balance.toLocaleString()}, Required: ₦${balanceDue.toLocaleString()}`,
      400
    ));
  }

  // Deduct from wallet
  wallet.balance -= balanceDue;
  await wallet.save();

  await WalletTransaction.create({
    walletId: wallet._id,
    customerId: orderUser.customerId,
    type: 'debit',
    amount: balanceDue,
    reason: `Balance payment for order ${order.orderNumber}`,
    balanceAfter: wallet.balance,
  });

  // Mark order as fully paid
  order.paymentStatus = 'paid';
  order.payment.status = 'paid';
  order.payment.amount = order.total; // now reflects full amount
  order.payment.paidAt = new Date();
  await order.save();

  // Trigger referral check for qualifyOnStatus: 'paid'
  await processReferralReward(order, 'paid', req.app.get('io'));

  const io = req.app.get('io');
  if (io) {
    io.to(`user-${orderUser.customerId}`).emit('wallet:balance-updated', {
      balance: wallet.balance,
      transaction: { type: 'debit', amount: balanceDue, reason: `Balance payment for order ${order.orderNumber}` },
    });
    io.to(`order-${order._id}`).emit('order:updated', {
      orderId: order._id,
      paymentStatus: 'paid',
    });
  }

  res.status(200).json({
    success: true,
    message: `₦${balanceDue.toLocaleString()} charged from wallet. Order fully paid.`,
    data: { order, amountCharged: balanceDue, walletBalance: wallet.balance },
  });
});

// @desc    Cancel order
// @route   PUT /api/v1/orders/:id/cancel
// @access  Private
exports.cancelOrder = asyncHandler(async (req, res, next) => {
  const { reason } = req.body;

  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Check if user has permission to cancel
  if (
    req.user.role === 'customer' &&
    order.customer.toString() !== req.user.id
  ) {
    return next(new AppError('Not authorized to cancel this order', 403));
  }

  // Check if order can be cancelled
  if (['delivered', 'completed', 'cancelled'].includes(order.status)) {
    return next(new AppError('Order cannot be cancelled', 400));
  }

  order.status = 'cancelled';
  order.notes = `Cancelled: ${reason}`;

  order.statusHistory.push({
    status: 'cancelled',
    updatedBy: req.user.id,
    notes: reason,
  });

  await order.save();

  // Auto-refund wallet if paid via wallet
  const paidViaWallet = order.payment?.method === 'wallet' && order.paymentStatus === 'paid';
  const refundAmount = order.payment?.amount || order.total || 0;
  let walletRefundIssued = false;

  if (paidViaWallet && refundAmount > 0) {
    const orderUser = await User.findById(order.customer).select('customerId').lean();
    if (orderUser?.customerId) {
      const wallet = await Wallet.findOne({ customerId: orderUser.customerId });
      if (wallet) {
        wallet.balance += refundAmount;
        await wallet.save();
        await WalletTransaction.create({
          walletId: wallet._id,
          customerId: orderUser.customerId,
          type: 'credit',
          amount: refundAmount,
          reason: `Order Cancellation Refund — ${order.orderNumber}`,
          balanceAfter: wallet.balance,
        });
        // Update payment status to refunded
        order.paymentStatus = 'refunded';
        order.payment.status = 'refunded';
        await order.save();
        walletRefundIssued = true;

        const io = req.app.get('io');
        if (io) {
          io.to(`user-${orderUser.customerId}`).emit('wallet:balance-updated', {
            balance: wallet.balance,
            transaction: { type: 'credit', amount: refundAmount, reason: `Order Cancellation Refund` },
          });
        }
      }
    }
  }

  // Notifications
  const cancelIo = req.app.get('io');
  // Resolve customer's customerId for notification room
  let cancelCustomerId = null;
  if (order.customer) {
    const cancelUser = await User.findById(order.customer).select('customerId').lean();
    cancelCustomerId = cancelUser?.customerId ? String(cancelUser.customerId) : null;
  }

  // Notify admin room
  await notify(cancelIo, {
    type: 'order_cancelled',
    title: 'Order Cancelled',
    body: `Order ${order.orderNumber} has been cancelled. Reason: ${reason || 'not specified'}.`,
    room: 'admin',
    metadata: { orderId: order._id, orderNumber: order.orderNumber, reason },
  });

  // Notify customer
  if (cancelCustomerId) {
    const cancelBody = walletRefundIssued
      ? `Your order ${order.orderNumber} has been cancelled. A refund of ₦${refundAmount.toLocaleString()} has been credited to your wallet.`
      : `Your order ${order.orderNumber} has been cancelled.`;
    await notify(cancelIo, {
      type: 'order_cancelled',
      title: 'Order Cancelled',
      body: cancelBody,
      customerId: cancelCustomerId,
      metadata: { orderId: order._id, orderNumber: order.orderNumber, refundAmount: walletRefundIssued ? refundAmount : 0 },
    });
  }

  res.status(200).json({
    success: true,
    message: 'Order cancelled successfully',
    data: { order, walletRefundIssued, refundAmount: walletRefundIssued ? refundAmount : 0 },
  });
});

// @desc    Add order item
// @route   POST /api/v1/orders/:id/items
// @access  Private
exports.addOrderItem = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (req.user.role === 'customer' && order.customer.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }

  const { serviceCategoryId, quantity, unitPrice, careType, serviceLevel } = req.body;

  const subtotal = quantity * unitPrice;

  const orderItem = await OrderItem.create({
    orderId: order._id,
    serviceCategoryId,
    quantity,
    unitPrice,
    subtotal,
    careType,
    serviceLevel,
  });

  res.status(201).json({
    success: true,
    message: 'Order item added successfully',
    data: { orderItem },
  });
});

// @desc    Remove order item
// @route   DELETE /api/v1/orders/:id/items/:itemId
// @access  Private
exports.removeOrderItem = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (req.user.role === 'customer' && order.customer.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }

  const orderItem = await OrderItem.findOneAndDelete({
    _id: req.params.itemId,
    orderId: order._id,
  });

  if (!orderItem) {
    return next(new AppError('Order item not found', 404));
  }

  res.status(200).json({
    success: true,
    message: 'Order item removed successfully',
    data: {},
  });
});

// @desc    Add order media
// @route   POST /api/v1/orders/:id/media
// @access  Private
exports.addOrderMedia = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  const { mediaUrl, note } = req.body;
  const source = req.user.role === 'customer' ? 'customer' : 'staff';

  const media = await OrderMedia.create({
    orderId: order._id,
    mediaUrl,
    source,
    note,
  });

  res.status(201).json({
    success: true,
    message: 'Media added successfully',
    data: { media },
  });
});

// @desc    Get order media
// @route   GET /api/v1/orders/:id/media
// @access  Private
exports.getOrderMedia = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (req.user.role === 'customer' && order.customer.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
  }

  const media = await OrderMedia.find({ orderId: order._id }).sort('-createdAt');

  res.status(200).json({
    success: true,
    message: 'Order media fetched successfully',
    data: { media },
  });
});

// @desc    Get customer order stats (total orders, total spent) + tier progress from DB tiers
// @route   GET /api/v1/orders/my-stats
// @access  Private (Customer)
exports.getMyStats = asyncHandler(async (req, res, next) => {
  const userId = req.user.id;
  if (!userId) {
    return next(new AppError('Not authorized', 403));
  }

  const mongoose = require('mongoose');

  // Aggregate total orders and total spent for this customer
  const [agg] = await Order.aggregate([
    { $match: { customer: new mongoose.Types.ObjectId(userId), status: { $ne: 'CANCELLED' } } },
    {
      $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        totalSpent: { $sum: '$total' },
      },
    },
  ]);

  const totalOrders = agg?.totalOrders || 0;
  const totalSpent = agg?.totalSpent || 0;

  // Load all active tiers sorted by minSpend ascending
  const tiers = await LoyaltyTier.find({ active: true }).sort({ minSpend: 1 });

  // Determine current tier and next tier based on totalSpent
  let currentTier = null;
  let nextTier = null;

  for (let i = 0; i < tiers.length; i++) {
    if (totalSpent >= tiers[i].minSpend) {
      currentTier = tiers[i];
      nextTier = tiers[i + 1] || null;
    }
  }

  // If no tier matched (spending below first tier), use first tier as next
  if (!currentTier && tiers.length > 0) {
    nextTier = tiers[0];
  }

  res.status(200).json({
    success: true,
    message: 'Stats fetched successfully',
    data: {
      totalOrders,
      totalSpent,
      currentTier: currentTier
        ? { name: currentTier.name, minSpend: currentTier.minSpend, rank: currentTier.rank }
        : null,
      nextTier: nextTier
        ? { name: nextTier.name, minSpend: nextTier.minSpend, rank: nextTier.rank }
        : null,
      tiers: tiers.map((t) => ({ name: t.name, minSpend: t.minSpend, rank: t.rank })),
    },
  });
});
