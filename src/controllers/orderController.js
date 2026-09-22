const Order = require('../models/Order.js');
// NOTE: models/OrderItem.js is now unreferenced. The collection it maps to was
// never read by anything and its two endpoints operate on order.items instead.
// The file and any existing documents are left in place deliberately — dropping
// them is a separate, reviewable cleanup.
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
const DeliveryZone = require('../models/DeliveryZone.js');
const PickupWindow = require('../models/PickupWindow.js');
const mongoose = require('mongoose');
const {
  normalizeEmail,
  resolveWalkInCustomer,
  portalUserFor,
  resolvePortalStatus,
  customerCanAccessOrder,
  customerOrderFilter,
  maskEmail,
  maskPhone,
} = require('../utils/customerIdentity.js');
const {
  loadLoyaltySettings,
  redemptionAvailable,
  redemptionPointsPerNaira,
  discountForPoints,
} = require('../utils/loyaltyRates.js');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const ERROR_CODES = require('../utils/errorCodes.js');
const {
  calculateOrderPricing,
  generateQRCode,
  paidOrderMatch,
  orderRevenueField,
  startOfTodayWAT,
  watDayEnd,
  getTodayWAT,
} = require('../utils/helpers.js');
const notify = require('../utils/notify.js');
const normalizePhone = require('../utils/normalizePhone.js');
const logger = require('../utils/logger.js');
const { logAudit } = require('../utils/auditLogger.js');

// Every status an order may hold — mirrors the enum on OrderSchema.status.
// Used to reject unknown values with a 400 instead of a raw Mongoose error.
const ORDER_STATUSES = [
  'draft', 'pending', 'confirmed', 'in_progress', 'picked-up', 'washing',
  'ironing', 'ready', 'out-for-delivery', 'delivered', 'completed', 'cancelled',
];

// Statuses an order does not move on from under normal operation
const TERMINAL_STATUSES = ['delivered', 'completed', 'cancelled'];

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

// ─── Promo code resolution (server-side) ─────────────────────────────────────
// Mirrors every check in promoController.validatePromoCode so a discount can never
// be claimed by simply posting one. Returns the PromoCode doc when the code is
// genuinely usable by this customer, otherwise null.
async function resolveUsablePromoCode(code, customerId) {
  if (!code) return null;

  const promo = await PromoCode.findOne({ code: String(code).toUpperCase(), active: true });
  if (!promo) return null;
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return null;

  const totalUsage = await PromoRedemption.countDocuments({ promoCodeId: promo._id });
  if (promo.usageLimit && totalUsage >= promo.usageLimit) return null;

  if (customerId && promo.usagePerUser > 0) {
    const userUsage = await PromoRedemption.countDocuments({
      promoCodeId: promo._id,
      customerId,
    });
    if (userUsage >= promo.usagePerUser) return null;
  }

  return promo;
}

// Money value of a validated promo code against a given base. Never exceeds the base.
function promoDiscountAmount(promo, base) {
  if (!promo || base <= 0) return 0;
  const raw = promo.type === 'percent'
    ? Math.round(base * promo.value / 100)
    : promo.value;
  return Math.max(0, Math.min(raw, base));
}

// ─── Loyalty points redemption (server-side) ─────────────────────────────────
// Works out how many points may actually be spent on this order and what they are
// worth, honouring every LoyaltySetting guard and the customer's real balance.
// Resolves only — the deduction happens separately so it can be rolled back.
async function resolvePointsRedemption(requestedPoints, customerId, discountableBase) {
  const none = { points: 0, amount: 0 };

  const requested = parseInt(requestedPoints, 10);
  if (!requested || requested <= 0 || !customerId || discountableBase <= 0) return none;

  // Read fresh on every checkout, so a rate the customer's page loaded earlier
  // is never the one that prices the order.
  const settings = await loadLoyaltySettings();
  // redemptionAvailable() covers the master programme switch too — previously
  // only the channel switch was checked here.
  if (!redemptionAvailable(settings)) return none;

  const customer = await Customer.findById(customerId).select('loyaltyPointsBalance').lean();
  if (!customer) return none;

  // Never spend more than the customer actually holds
  let usable = Math.min(requested, customer.loyaltyPointsBalance || 0);

  // Per-order point ceiling
  if (settings.maxRedeemPointsPerOrder > 0) {
    usable = Math.min(usable, settings.maxRedeemPointsPerOrder);
  }

  // Value ceiling — points may only cover maxRedeemPercent of the order.
  // Expressed in points-per-₦1, the same unit as every other loyalty rate; this
  // used to read pointsRedemptionValue, an inverted ₦-per-point field that the
  // admin dashboard never exposed and which therefore valued points at 25× the
  // configured rate.
  const pointsPerNaira = redemptionPointsPerNaira(settings);
  const maxPct         = settings.maxRedeemPercent > 0 ? settings.maxRedeemPercent : 100;
  const maxAmount      = Math.floor(discountableBase * maxPct / 100);
  usable = Math.min(usable, maxAmount * pointsPerNaira);

  if (usable <= 0) return none;

  // Minimum redemption floor, applied after clamping so the customer is never
  // charged points for a redemption below the configured threshold.
  const minRedeem = settings.minRedeemPoints || 0;
  if (minRedeem > 0 && usable < minRedeem) return none;

  const amount = discountForPoints(usable, settings);
  if (amount <= 0) return none;

  // Never let the discount exceed the base it applies to.
  return { points: usable, amount: Math.min(amount, discountableBase) };
}

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
      // Atomic upsert-and-credit — no read-modify-write window, no separate create to race
      const referrerWallet = await Wallet.findOneAndUpdate(
        { customerId: referrerUser.customerId },
        { $inc: { balance: referrerRewardAmount } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
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
      const refereeWallet = await Wallet.findOneAndUpdate(
        { customerId: refereeUser.customerId },
        { $inc: { balance: refereeRewardAmount } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
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

  // Credit customer balance + lifetime spend
  const updatedCustomer = await Customer.findByIdAndUpdate(
    customerId,
    { $inc: { loyaltyPointsBalance: points, loyaltyLifetimePoints: points, lifetimeSpend: orderAmount } },
    { new: true }
  ).lean();

  // Tier upgrade check — customer qualifies when BOTH point and spend thresholds are met
  if (updatedCustomer) {
    const allTiers = await LoyaltyTier.find({ active: true }).sort('rank').lean();
    const lifetimePts   = updatedCustomer.loyaltyLifetimePoints || 0;
    const lifetimeSpend = updatedCustomer.lifetimeSpend || 0;
    const eligible = allTiers
      .filter(t => t.pointsRequired <= lifetimePts && (t.minSpend === 0 || t.minSpend <= lifetimeSpend))
      .pop(); // highest qualifying rank
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
  // Idempotency: if the client retried after a lost response, return the existing order
  const idempotencyKey = req.body.idempotencyKey;
  if (idempotencyKey) {
    const existing = await Order.findOne({ idempotencyKey }).select('+idempotencyKey').lean();
    if (existing) {
      return res.status(200).json({ success: true, data: { order: existing } });
    }
  }

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
    pointsToRedeem: bodyPointsToRedeem,
  } = req.body;

  const isStaffRole = ['staff', 'admin', 'manager', 'developer'].includes(req.user.role);
  // Auto-classify: staff/admin/manager always creates walk-in (offline); customers always create online
  const isOffline = isStaffRole;

  // Determine the customer for this order
  let orderCustomerId = null;
  let orderCustomerRefId = null;

  // Filled in for staff orders so the response can tell the counter whether
  // an existing customer was found or a new record was created.
  let customerRecordInfo = null;

  if (isOffline && isStaffRole) {
    // ── Walk-in: every order belongs to a customer record ───────────────────
    // A person becomes a customer the moment an order exists for them. This
    // used to leave customerId null unless the phone happened to match a
    // registered account, so walk-in customers were counted nowhere and had
    // no record to activate later.
    if (!walkInCustomer || !walkInCustomer.name) {
      return next(new AppError('Walk-in customer name is required for offline orders', 400));
    }
    if (!walkInCustomer.phone) {
      return next(new AppError('Walk-in customer phone number is required for offline orders', 400));
    }

    // Normalize phone to E.164 before storing; email is optional.
    const normalized = normalizePhone(walkInCustomer.phone);
    if (normalized) walkInCustomer.phone = normalized;
    const walkInEmail = normalizeEmail(walkInCustomer.email);
    if (walkInCustomer.email && !walkInEmail) {
      return next(new AppError('The email address entered is not valid', 400, ERROR_CODES.VALIDATION_ERROR));
    }
    walkInCustomer.email = walkInEmail || undefined;

    let customerRecord;
    if (req.body.customerRecordId) {
      // Staff picked an existing customer from the lookup. Used as chosen —
      // this is also how a phone/email conflict is resolved at the counter.
      if (!mongoose.isValidObjectId(req.body.customerRecordId)) {
        return next(new AppError('Invalid customer record', 400));
      }
      customerRecord = await Customer.findById(req.body.customerRecordId);
      if (!customerRecord) {
        return next(new AppError('Selected customer record not found', 404));
      }
      customerRecordInfo = { created: false, selected: true };
    } else {
      try {
        const r = await resolveWalkInCustomer({
          name: walkInCustomer.name,
          phone: walkInCustomer.phone,
          email: walkInEmail,
          actor: req.user,
        });
        customerRecord = r.customer;
        customerRecordInfo = { created: r.created, selected: false };
      } catch (err) {
        if (err.code !== 'IDENTITY_CONFLICT') throw err;
        // Phone belongs to one customer, email to another. Never pick one
        // automatically — the person at the counter chooses, then resubmits
        // with customerRecordId. Contact details are masked.
        return res.status(409).json({
          success: false,
          message: 'This phone number and email belong to two different customers. Choose the right customer to continue.',
          error: { code: 'IDENTITY_CONFLICT' },
          data: {
            candidates: err.candidates.map((c) => ({
              customerRecordId: c._id,
              name: c.name,
              phone: maskPhone(c.phone),
              email: maskEmail(c.email),
            })),
          },
        });
      }
    }

    orderCustomerRefId = customerRecord._id;
    // If this customer has a portal account, link it too so the order shows up
    // on their dashboard immediately.
    const portalUser = await portalUserFor(customerRecord._id);
    if (portalUser) orderCustomerId = portalUser._id;
    customerRecordInfo.customerRecordId = customerRecord._id;
    // This order is itself a walk-in, so the record has walk-in history.
    customerRecordInfo.portalStatus = resolvePortalStatus({ user: portalUser, customer: customerRecord, hasWalkInHistory: true });
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

  // ── Pickup / delivery fees (server-derived) ───────────────────────────────
  // These used to be taken straight from the request body. Every other money
  // component on this order is rebuilt from the DB, but these two were not —
  // so a customer could post deliveryFee: 0 to ride free, or a negative figure
  // to drive the whole total to 0 (calculateOrderPricing clamps at 0, which hid
  // it). The authoritative figures live on DeliveryZone.fee / PickupWindow.baseFee,
  // with the rush surcharge added the same way the checkout screen shows it.
  //
  // Staff keep manual fee entry at the counter — a walk-in has no zone or window
  // to look up — but the value is still clamped to a non-negative number so a
  // fee can never act as an unaudited discount.
  const resolvedDeliveryZoneId  = req.body.deliveryZoneId  || undefined;
  const resolvedPickupWindowId  = req.body.pickupWindowId  || undefined;

  const clampFee = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
  };

  let resolvedPickupFee   = 0;
  let resolvedDeliveryFee = 0;

  if (isStaffRole) {
    resolvedPickupFee   = clampFee(bodyPickupFee ?? (pricing && pricing.pickupFee));
    resolvedDeliveryFee = clampFee(req.body.deliveryFee ?? (pricing && pricing.deliveryFee));
  }

  // Customer-placed orders (and any staff order that did name a zone/window)
  // price the legs from the DB, ignoring whatever the client asked for.
  if (resolvedPickupWindowId) {
    const win = await PickupWindow.findById(resolvedPickupWindowId).lean();
    if (win && win.active !== false) {
      resolvedPickupFee = clampFee((win.baseFee || 0) + (rush ? (win.rushFee || 0) : 0));
    } else if (!isStaffRole) {
      return next(new AppError('The selected pickup window is no longer available', 400));
    }
  } else if (!isStaffRole) {
    resolvedPickupFee = 0;
  }

  if (resolvedDeliveryZoneId) {
    const zone = await DeliveryZone.findById(resolvedDeliveryZoneId).lean();
    if (zone && zone.active !== false) {
      resolvedDeliveryFee = clampFee((zone.fee || 0) + (rush ? (zone.rushFee || 0) : 0));
    } else if (!isStaffRole) {
      return next(new AppError('The selected delivery zone is no longer available', 400));
    }
  } else if (!isStaffRole) {
    resolvedDeliveryFee = 0;
  }

  // ── Discount: rebuilt on the server, never taken from the request ──────────
  // The client sends which promo code and how many points it wants to use; the
  // amounts are derived here from the DB so a crafted request cannot conjure a
  // discount. Staff keep their manual counter discount, but it is bounded and
  // attributed (see manualDiscount below).
  //
  // Order matters: tier benefit first, then promo, then points, then any manual
  // discount — each one sees the base the previous ones left behind. Resolving
  // points before the tier discount would let them over-cover a tier-discounted
  // order and silently burn point value the customer never received.
  const discountableBase = baseSubtotal + serviceFee + addOnsFee;

  // ── Loyalty tier benefits (server-derived) ────────────────────────────────
  let loyaltyTierSnapshot = null;
  let tierDiscount        = 0;
  if (orderCustomerRefId) {
    const loyalCustomer = await Customer.findById(orderCustomerRefId)
      .populate('loyaltyTierId')
      .lean();
    const tier = loyalCustomer?.loyaltyTierId;
    if (tier && tier.active) {
      tierDiscount = tier.discountPercent > 0
        ? Math.round(baseSubtotal * tier.discountPercent / 100)
        : 0;
      if (tier.freePickup)   resolvedPickupFee   = 0;
      if (tier.freeDelivery) resolvedDeliveryFee = 0;
      loyaltyTierSnapshot = {
        tierId:           tier._id,
        tierName:         tier.name,
        discountPercent:  tier.discountPercent || 0,
        discountAmount:   tierDiscount,
        freeDelivery:     tier.freeDelivery || false,
        freePickup:       tier.freePickup || false,
        priorityHandling: tier.priorityTurnaround || false,
        multiplierPercent: tier.multiplierPercent || 100,
      };
    }
  }

  const validPromo    = await resolveUsablePromoCode(bodyPromoCode, orderCustomerRefId);
  const promoDiscount = promoDiscountAmount(validPromo, Math.max(0, discountableBase - tierDiscount));

  let pointsRedemption = await resolvePointsRedemption(
    bodyPointsToRedeem,
    orderCustomerRefId,
    Math.max(0, discountableBase - tierDiscount - promoDiscount)
  );

  // Reserve the points now, before the order is written, so two concurrent
  // checkouts cannot spend the same balance. Released again if creation fails.
  let pointsBalanceAfter = null;
  if (pointsRedemption.points > 0) {
    const reserved = await Customer.findOneAndUpdate(
      { _id: orderCustomerRefId, loyaltyPointsBalance: { $gte: pointsRedemption.points } },
      { $inc: { loyaltyPointsBalance: -pointsRedemption.points } },
      { new: true }
    );
    if (reserved) {
      pointsBalanceAfter = reserved.loyaltyPointsBalance;
    } else {
      // Balance moved between resolve and reserve — drop the points discount
      pointsRedemption = { points: 0, amount: 0 };
    }
  }

  // Staff may apply a manual discount at the counter. Customers may not — any
  // discount in a customer request is ignored entirely.
  let manualDiscount = 0;
  if (isStaffRole && bodyDiscount != null) {
    const requested = Number(bodyDiscount);
    if (Number.isFinite(requested) && requested > 0) {
      manualDiscount = Math.min(
        Math.round(requested),
        Math.max(0, discountableBase - tierDiscount - promoDiscount - pointsRedemption.amount)
      );
    }
  }

  // Sum of every server-derived component. Bounded by discountableBase because
  // each component above was clamped against what the previous ones left.
  const resolvedDiscount = tierDiscount + promoDiscount + pointsRedemption.amount + manualDiscount;

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
  const orderDoc = {
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
    // Both were declared on the schema and populated by getOrder, but never
    // written here — so every order carried null and receipts could not show
    // which zone was charged. They are also the source the fees above are
    // derived from, so persisting them makes the pricing reproducible.
    deliveryZoneId: resolvedDeliveryZoneId,
    pickupWindowId: resolvedPickupWindowId,
    deliveryFee: resolvedDeliveryFee,
    rush: rush || false,
    stainRemoval: stainRemoval || false,
    fragrance: fragrance || false,
    addons: resolvedAddons,
    loyaltyTierSnapshot: loyaltyTierSnapshot || undefined,
    priorityHandling: loyaltyTierSnapshot?.priorityHandling || false,
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
    idempotencyKey: idempotencyKey || undefined,
    // Server-derived loyalty redemption applied to this order
    loyaltyPointsRedeemed: pointsRedemption.points,
    loyaltyDiscountAmount: pointsRedemption.amount,
    promoCodeId: validPromo ? validPromo._id : undefined,
  };

  let order;
  try {
    // Retry only on an orderNumber collision. The pre-validate hook allocates a
    // fresh sequence on each attempt, so a retry resolves it. Any other duplicate
    // key (idempotencyKey, code) is a real conflict and must surface.
    let attempt = 0;
    for (;;) {
      try {
        order = await Order.create(orderDoc);
        break;
      } catch (err) {
        const isOrderNumberClash = err.code === 11000 && /orderNumber/i.test(err.message || '');
        if (!isOrderNumberClash || ++attempt >= 5) throw err;
        logger.warn(`[createOrder] orderNumber collision, retry ${attempt}/5`);
      }
    }
  } catch (createErr) {
    // Release the points reserved above — a failed write must never cost the customer
    if (pointsRedemption.points > 0 && orderCustomerRefId) {
      await Customer.findByIdAndUpdate(orderCustomerRefId, {
        $inc: { loyaltyPointsBalance: pointsRedemption.points },
      }).catch((e) => logger.error(`[createOrder] Point rollback failed: ${e.message}`));
    }
    throw createErr;
  }

  // Generate QR code
  order.qrCode = generateQRCode(order.orderNumber);
  await order.save();

  // Record the loyalty redemption in the ledger. The points were already deducted
  // above; the unique { orderId, type } index keeps this to one row per order.
  if (pointsRedemption.points > 0 && orderCustomerRefId) {
    try {
      await LoyaltyLedger.create({
        customerId:   orderCustomerRefId,
        orderId:      order._id,
        points:       -pointsRedemption.points,
        type:         'redeem',
        source:       'order',
        reason:       `Redeemed on Order ${order.orderNumber}`,
        balanceAfter: pointsBalanceAfter,
      });
      const redeemIo = req.app.get('io');
      if (redeemIo) {
        redeemIo.to(`user-${orderCustomerRefId}`).emit('loyalty:points-redeemed', {
          points:  pointsRedemption.points,
          amount:  pointsRedemption.amount,
          balance: pointsBalanceAfter,
          orderId: order._id,
        });
      }
    } catch (ledgerErr) {
      if (ledgerErr.code !== 11000) {
        logger.error(`[createOrder] Loyalty ledger write failed for ${order.orderNumber}: ${ledgerErr.message}`);
      }
    }
  }

  // Record the promo redemption. validPromo was already checked against expiry,
  // global limit and per-user limit before the discount was applied, so there is
  // no second validation here that could pass the discount but skip the record.
  // Recorded for walk-ins too (customerId null) so the global usageLimit counts
  // counter redemptions. Skipping them let a limited code be reused forever.
  if (validPromo && promoDiscount > 0) {
    try {
      await PromoRedemption.create({
        promoCodeId: validPromo._id,
        orderId:     order._id,
        customerId:  orderCustomerRefId || null,
        amount:      promoDiscount,
      });

      // Auto-disable when the global usage limit is reached
      if (validPromo.usageLimit) {
        const totalUsage = await PromoRedemption.countDocuments({ promoCodeId: validPromo._id });
        if (totalUsage >= validPromo.usageLimit) {
          await PromoCode.findByIdAndUpdate(validPromo._id, { active: false });
        }
      }
    } catch (err) {
      if (err.code !== 11000) {
        logger.error(`[createOrder] Promo redemption recording failed for ${order.orderNumber}: ${err.message}`);
      }
    }
  }

  // Handle wallet payment if payment method is 'wallet'
  if (paymentMethod && paymentMethod.toLowerCase() === 'wallet') {
    try {
      // Atomic check-and-debit. Returns null when the wallet is missing or short,
      // in which case the order simply stays unpaid and the customer can pay later.
      const wallet = await Wallet.findOneAndUpdate(
        { customerId: orderCustomerRefId, balance: { $gte: orderPricing.total } },
        { $inc: { balance: -orderPricing.total } },
        { new: true }
      );

      if (!wallet) {
        // Leave payment pending — the customer can pay separately. Never fail the
        // whole request here: the order is already persisted at this point.
        logger.warn(`[createOrder] Wallet payment skipped for order ${order.orderNumber}: wallet missing or insufficient balance`);
      } else {
        await WalletTransaction.create({
          walletId: wallet._id,
          customerId: orderCustomerRefId,
          type: 'debit',
          amount: orderPricing.total,
          reason: `Payment for order ${order.orderNumber}`,
          balanceAfter: wallet.balance,
          orderId: order._id,
          source: 'order',
        });

        order.payment.status = 'paid';
        order.payment.paidAt = new Date();
        order.paymentStatus = 'paid';
        await order.save();

        await processReferralReward(order, 'paid', req.app.get('io')).catch(() => {});

        const io = req.app.get('io');
        if (io) {
          io.to(`user-${orderCustomerRefId}`).emit('wallet:balance-updated', {
            balance: wallet.balance,
            transaction: { type: 'debit', amount: orderPricing.total, reason: `Payment for order ${order.orderNumber}` },
          });
        }
      }
    } catch (walletErr) {
      logger.error(`[createOrder] Wallet payment failed for order ${order.orderNumber}: ${walletErr.message}`);
      // Order already saved — let it proceed as unpaid so customer can retry payment
    }
  }

  // Emit socket event + send notifications (fire-and-forget — must not block the response)
  try {
    const io = req.app.get('io');
    if (io) {
      io.emit('order-created', order);
      io.to(`user-${orderCustomerRefId || orderCustomerId}`).emit('order:created', order);
    }

    await notify(io, {
      type: 'order_created',
      title: 'New Order Received',
      body: `Order ${order.orderNumber} has been placed${order.orderSource === 'online' ? ' online' : ' (walk-in)'}.`,
      room: 'admin',
      metadata: { orderId: order._id, orderNumber: order.orderNumber, total: order.total },
    });

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

    if (orderCustomerRefId || orderCustomerId) {
      await notify(io, {
        type: 'order_created',
        title: 'Order Confirmed',
        body: `Your order ${order.orderNumber} has been received and is being processed.`,
        customerId: String(orderCustomerRefId || orderCustomerId),
        metadata: { orderId: order._id, orderNumber: order.orderNumber },
      });
    }
  } catch (notifyErr) {
    logger.error(`[createOrder] Notification/socket failed for order ${order.orderNumber}: ${notifyErr.message}`);
  }

  res.status(201).json({
    success: true,
    message: 'Order created successfully',
    // customerRecord tells the counter whether an existing customer was found
    // or a new record was created (walk-in orders only).
    data: { order, ...(customerRecordInfo ? { customerRecord: customerRecordInfo } : {}) },
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

  // Customer UI always sends scope=customer — enforces personal-only view regardless of role.
  // This prevents staff accounts logged into the customer UI from seeing all orders.
  const isCustomerScope = req.user.role === 'customer' || req.query.scope === 'customer';

  // Customers (or any role in customer-scope mode) see every order that belongs
  // to them — placed online or at the counter — through their account or the
  // customer record it is linked to. No date restriction: orders from before
  // the account existed are theirs too.
  //
  // This used to also match walk-in orders by the phone on the account. That
  // phone was never verified, so registering with someone else's number showed
  // you their orders. Walk-in orders now carry customerId instead, and an
  // account is only linked to a customer record through a verified identifier.
  if (isCustomerScope) {
    query = customerOrderFilter(req.user);
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
      const isAdminRole = ['admin', 'manager', 'receptionist', 'developer'].includes(req.user.role);

      query.status = st;
      // All statuses: staff see all orders globally.
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

    // Delivery-role: restrict to delivery-type orders only.
    //
    // Kept in $and rather than $or so it composes with the $or that the
    // statusTab + myOrders branch may already have built (assigning to $or
    // silently discarded it) and so the search block below, which resets $or,
    // cannot drop the restriction either.
    if (req.user.role === 'delivery') {
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { orderType: 'pickup-delivery' },
            { deliveryAddress: { $exists: true, $ne: null } },
          ],
        },
      ];
    }
  }

  // Cross-status search — when ?search= is provided, wipe tab/status filters
  // and match orderNumber, code, or walk-in customer name/phone across ALL statuses.
  if (req.query.search?.trim() && req.user.role !== 'customer') {
    const raw = req.query.search.trim();
    const regex = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    delete query.status;
    delete query.assignedStaff;
    delete query.$or;
    // NB: query.$and is intentionally preserved — it carries the delivery-role
    // scope, which a search must not be able to escape.
    query.$or = [
      { orderNumber: regex },
      { code: regex },
      { 'walkInCustomer.name': regex },
      { 'walkInCustomer.phone': regex },
    ];
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
    .populate('serviceLevelId', 'name percentageAdjustment priorityLevel')
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

// @desc    Aggregate dashboard stats — accurate across all orders (no pagination)
// @route   GET /api/v1/orders/dashboard-stats
// @access  Private (admin, manager)
exports.getOrderDashboardStats = asyncHandler(async (req, res) => {
  // WAT calendar day, not the container's local timezone
  const todayStart = startOfTodayWAT();
  const todayEnd   = watDayEnd(getTodayWAT());

  const INACTIVE_STATUSES = ['delivered', 'completed', 'cancelled'];

  const [aggResult, totalOrders, activeOrders, pendingPayments, todayOrders] = await Promise.all([
    // Total revenue (all paid orders ever) + today's revenue
    Order.aggregate([
      {
        $facet: {
          totalRevenue: [
            { $match: paidOrderMatch() },
            { $group: { _id: null, sum: { $sum: orderRevenueField() } } },
          ],
          todayRevenue: [
            { $match: { ...paidOrderMatch(), createdAt: { $gte: todayStart, $lte: todayEnd } } },
            { $group: { _id: null, sum: { $sum: orderRevenueField() } } },
          ],
        },
      },
    ]),
    Order.countDocuments({}),
    Order.countDocuments({ status: { $nin: INACTIVE_STATUSES } }),
    Order.countDocuments({ paymentStatus: { $in: ['unpaid', 'partial'] } }),
    Order.countDocuments({ createdAt: { $gte: todayStart, $lte: todayEnd } }),
  ]);

  const facets = aggResult[0] || {};
  const totalRevenue = facets.totalRevenue?.[0]?.sum ?? 0;
  const todayRevenue = facets.todayRevenue?.[0]?.sum ?? 0;

  res.status(200).json({
    success: true,
    data: { totalRevenue, todayRevenue, totalOrders, activeOrders, pendingPayments, todayOrders },
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
    .populate('serviceLevelId', 'name percentageAdjustment priorityLevel')
    .populate('statusHistory.updatedBy', 'name role')
    .populate('deliveryZoneId', 'name fee rushFee radiusKm')
    .populate('pickupWindowId', 'startTime endTime dayOfWeek baseFee');

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Enforce ownership for customers and for any role using the customer-scope UI.
  // This prevents staff accounts logged into the customer UI from viewing others' orders.
  const isCustomerScope = req.user.role === 'customer' || req.query.scope === 'customer';
  if (isCustomerScope && !customerCanAccessOrder(req.user, order)) {
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

    const pickupFee   = req.body.pickupFee   !== undefined ? Number(req.body.pickupFee)   : (order.pricing?.pickupFee   || 0);
    const deliveryFee = req.body.deliveryFee !== undefined ? Number(req.body.deliveryFee) : (order.pricing?.deliveryFee || 0);
    const discount    = req.body.discount    !== undefined ? Number(req.body.discount)    : (order.pricing?.discount    || 0);

    const newPricing = calculateOrderPricing(pricedItems, pickupFee, deliveryFee, discount, serviceFee, addOnsFee);
    order.pricing = newPricing;
    order.total   = newPricing.total;
    // Keep the top-level mirror in step with pricing.deliveryFee — createOrder
    // now populates it, and a later edit must not leave the two disagreeing.
    order.deliveryFee = newPricing.deliveryFee;
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
      const wallet = await Wallet.findOneAndUpdate(
        { customerId: orderUser.customerId },
        { $inc: { balance: difference } },
        { new: true }
      );
      if (wallet) {
        await WalletTransaction.create({
          walletId: wallet._id,
          customerId: orderUser.customerId,
          orderId: order._id,
          type: 'credit',
          amount: difference,
          reason: `Order Adjustment Refund — ${order.orderNumber}`,
          balanceAfter: wallet.balance,
          source: 'order',
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

  if (previousTotal !== newTotal) {
    await logAudit({
      actorUserId: req.user.id,
      action: 'ORDER_PRICE_CHANGED',
      targetType: 'Order',
      targetId: order._id.toString(),
      before: { total: previousTotal, paymentStatus: previousPaymentStatus },
      after: { total: newTotal, paymentStatus: order.paymentStatus },
      metadata: {
        orderNumber: order.orderNumber,
        difference,
        refundIssued,
        refundAmount,
        note: req.body.editNote || undefined,
      },
    });
  }

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

  // ── Transition guard ───────────────────────────────────────────────────────
  // Deliberately permissive about movement *within* the active pipeline: an
  // iron-only order legitimately skips washing, and staff need to walk a status
  // back after a mis-tap. What it does stop is unknown values, no-op re-sends
  // (which used to duplicate history rows and re-notify the customer) and
  // anyone below manager reopening a finished or cancelled order.
  if (!ORDER_STATUSES.includes(status)) {
    return next(new AppError(
      `'${status}' is not a valid order status`,
      400,
      ERROR_CODES.VALIDATION_ERROR
    ));
  }

  if (order.status === status) {
    return res.status(200).json({
      success: true,
      message: `Order is already ${status}`,
      data: { order },
    });
  }

  const isSupervisor = ['admin', 'manager', 'developer'].includes(req.user.role);
  // 'delivered' → 'completed' is the normal close-out and stays open to everyone
  const isRoutineCloseOut = order.status === 'delivered' && status === 'completed';

  if (TERMINAL_STATUSES.includes(order.status) && !isRoutineCloseOut && !isSupervisor) {
    return next(new AppError(
      `Order is ${order.status}. Only a manager or admin can reopen it.`,
      403
    ));
  }

  const previousStatus = order.status;

  if (order.status === 'cancelled') {
    // Wallet refund was already issued on cancellation — reset to unpaid so the
    // customer pays again through the normal flow.
    order.paymentStatus = 'unpaid';
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
    actorRole: req.user.role,
    notes,
  });

  await order.save();

  await logAudit({
    actorUserId: req.user.id,
    action: 'ORDER_STATUS_CHANGED',
    targetType: 'Order',
    targetId: order._id.toString(),
    before: { status: previousStatus },
    after: { status },
    metadata: { orderNumber: order.orderNumber, notes: notes || undefined },
  });

  // Auto-refund wallet if order was paid via wallet and is now being cancelled
  let walletRefundIssued = false;
  let refundAmount = 0;
  if (status === 'cancelled' && order.payment?.method === 'wallet' && order.paymentStatus === 'paid') {
    refundAmount = order.payment?.amount || order.total || 0;
    if (refundAmount > 0) {
      const orderUser = await User.findById(order.customer).select('customerId').lean();
      if (orderUser?.customerId) {
        const wallet = await Wallet.findOneAndUpdate(
          { customerId: orderUser.customerId },
          { $inc: { balance: refundAmount } },
          { new: true }
        );
        if (wallet) {
          await WalletTransaction.create({
            walletId: wallet._id,
            customerId: orderUser.customerId,
            orderId: order._id,
            type: 'credit',
            amount: refundAmount,
            reason: `Order Cancellation Refund — ${order.orderNumber}`,
            balanceAfter: wallet.balance,
            source: 'order',
          });
          order.paymentStatus = 'refunded';
          order.payment.status = 'refunded';
          await order.save();
          walletRefundIssued = true;

          const refundIo = req.app.get('io');
          if (refundIo) {
            refundIo.to(`user-${orderUser.customerId}`).emit('wallet:balance-updated', {
              balance: wallet.balance,
              transaction: { type: 'credit', amount: refundAmount, reason: 'Order Cancellation Refund' },
            });
          }
        }
      }
    }
  }

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
      const notifBody = walletRefundIssued
        ? `Your order ${order.orderNumber} has been cancelled. A refund of ₦${refundAmount.toLocaleString()} has been credited to your wallet.`
        : `Your order ${order.orderNumber} is now ${label}.`;
      await notify(io, {
        type: 'order_status_updated',
        title: 'Order Update',
        body: notifBody,
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

  // Only the assigned delivery staff (or admin/manager/developer) can confirm delivery
  const isAdminRole = ['admin', 'manager', 'developer'].includes(req.user.role);
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
    actorRole: req.user.role,
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
    actorRole: req.user.role,
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
    actorRole: req.user.role,
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
    actorRole: req.user.role,
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

  // Only the assigned pickup staff (or admin/manager/developer) can scan
  const isAdminRole = ['admin', 'manager', 'developer'].includes(req.user.role);
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
    actorRole: req.user.role,
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

  // `status` is optional: the admin order page uses this endpoint to change only
  // the payment method (OrderDetailPage sends { method } alone), and the blanket
  // validation below rejected that with a 400 — the button did nothing. Validate
  // the value only when one was actually supplied, and otherwise keep the status
  // the order already has.
  const PAYMENT_STATES = ['pending', 'paid', 'failed', 'refunded'];
  if (status !== undefined && !PAYMENT_STATES.includes(status)) {
    return next(new AppError(`'${status}' is not a valid payment status`, 400, ERROR_CODES.VALIDATION_ERROR));
  }
  if (status === undefined && method === undefined && transactionId === undefined) {
    return next(new AppError('Nothing to update', 400, ERROR_CODES.VALIDATION_ERROR));
  }

  const beforePayment = {
    paymentStatus: order.paymentStatus,
    status: order.payment?.status,
    method: order.payment?.method,
  };

  if (method) order.payment.method = method;
  if (transactionId) order.payment.transactionId = transactionId;

  // ── Amount taken at the counter ───────────────────────────────────────────
  // This handler used to flip the status without ever recording a figure, so
  // `payment.amount` kept the full total it was seeded with at creation and a
  // part-payment read back as settled in full. When an amount is supplied it is
  // now the thing that decides the status: short of the total is 'partial'.
  const orderTotal = order.total || order.pricing?.total || 0;
  // A method-only update leaves the payment state exactly as it was.
  let resolvedStatus = status === undefined ? order.payment?.status : status;

  if (status === 'paid') {
    const requested = req.body.amount !== undefined ? Number(req.body.amount) : orderTotal;

    if (!Number.isFinite(requested) || requested <= 0) {
      return next(new AppError('Payment amount must be greater than 0', 400, ERROR_CODES.VALIDATION_ERROR));
    }
    if (requested > orderTotal + 0.01) {
      return next(new AppError(
        `Payment of ₦${requested.toLocaleString()} exceeds the order total of ₦${orderTotal.toLocaleString()}`,
        400,
        ERROR_CODES.VALIDATION_ERROR
      ));
    }

    order.payment.amount = Math.round(requested * 100) / 100;
    order.payment.paidAt = Date.now();
    // Sub-kobo tolerance, same rule the Paystack settlement path uses
    if (order.payment.amount < orderTotal - 0.01) resolvedStatus = 'partial';
  }

  // 'partial' is a paymentStatus value, not a payment.status value — the
  // embedded subdocument enum has no such member, so it stays 'pending'.
  order.payment.status = resolvedStatus === 'partial' ? 'pending' : resolvedStatus;

  // Keep top-level paymentStatus in sync so normalisation on the frontend is
  // consistent — but only when a status was actually supplied. A method-only
  // update must not touch it: payment.status is 'pending' for a partial payment,
  // so mapping it back would silently downgrade a 'partial' order to 'unpaid'.
  const paymentStatusMap = { pending: 'unpaid', paid: 'paid', partial: 'partial', failed: 'unpaid', refunded: 'refunded' };
  if (status !== undefined && paymentStatusMap[resolvedStatus]) {
    order.paymentStatus = paymentStatusMap[resolvedStatus];
  }

  await order.save();

  await logAudit({
    actorUserId: req.user.id,
    action: 'ORDER_PAYMENT_UPDATED',
    targetType: 'Order',
    targetId: order._id.toString(),
    before: beforePayment,
    after: {
      paymentStatus: order.paymentStatus,
      status: order.payment?.status,
      method: order.payment?.method,
    },
    metadata: { orderNumber: order.orderNumber, amount: order.payment?.amount, transactionId },
  });

  // Handle referral auto-qualification for qualifyOnStatus: 'paid'.
  // Keyed off the resolved status so a part-payment does not qualify a referral.
  if (resolvedStatus === 'paid') {
    await processReferralReward(order, 'paid', req.app.get('io'));
  }

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:updated', {
      orderId: order._id,
      // The top-level status is the one the UIs normalise on, and the only one
      // that can express 'partial'.
      paymentStatus: order.paymentStatus,
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

  if (!['partial', 'unpaid'].includes(order.paymentStatus)) {
    return next(new AppError('Order is already paid or cannot be charged', 400));
  }

  if (order.paymentStatus === 'unpaid' && !['pay-later', 'wallet'].includes(order.payment?.method)) {
    return next(new AppError('Only pay-later or wallet orders can be charged via wallet when unpaid', 400));
  }

  // For pay-later (unpaid) orders, no real payment has been made yet — treat as 0
  const alreadyPaid = order.paymentStatus === 'unpaid' ? 0 : (order.payment?.amount || 0);
  const balanceDue = Math.round((order.total - alreadyPaid) * 100) / 100;

  if (balanceDue <= 0) {
    return next(new AppError('No outstanding balance on this order', 400));
  }

  // Resolve customer wallet
  const orderUser = await User.findById(order.customer).select('customerId').lean();
  if (!orderUser?.customerId) {
    return next(new AppError('Customer wallet not found', 404));
  }

  const existingWallet = await Wallet.findOne({ customerId: orderUser.customerId });
  if (!existingWallet) return next(new AppError('Customer does not have a wallet', 404));

  // Atomic check-and-debit — the balance guard and the deduction are one operation,
  // so two concurrent charges cannot both pass the check and overdraw the wallet.
  const wallet = await Wallet.findOneAndUpdate(
    { _id: existingWallet._id, balance: { $gte: balanceDue } },
    { $inc: { balance: -balanceDue } },
    { new: true }
  );

  if (!wallet) {
    return next(new AppError(
      `Insufficient wallet balance. Balance: ₦${existingWallet.balance.toLocaleString()}, Required: ₦${balanceDue.toLocaleString()}`,
      400
    ));
  }

  await WalletTransaction.create({
    walletId: wallet._id,
    customerId: orderUser.customerId,
    orderId: order._id,
    type: 'debit',
    amount: balanceDue,
    reason: `Balance payment for order ${order.orderNumber}`,
    balanceAfter: wallet.balance,
    source: 'order',
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
    io.emit('leaderboard:updated');
  }

  res.status(200).json({
    success: true,
    message: `₦${balanceDue.toLocaleString()} charged from wallet. Order fully paid.`,
    data: { order, amountCharged: balanceDue, walletBalance: wallet.balance },
  });
});

// @desc    Customer pays an unpaid/partial order from their own wallet
// @route   POST /api/v1/orders/:id/pay-wallet
// @access  Private (Customer — order owner only)
exports.customerPayWithWallet = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError('Order not found', 404));

  // Ownership: the customer's account or customer record (see customerIdentity).
  if (!customerCanAccessOrder(req.user, order)) {
    return next(new AppError('Not authorized to pay for this order', 403));
  }

  // Prevent double payment
  if (order.paymentStatus === 'paid') {
    return next(new AppError('Order is already paid', 409));
  }

  if (!['unpaid', 'partial'].includes(order.paymentStatus)) {
    return next(new AppError('Order cannot be paid in this state', 400));
  }

  const alreadyPaid = order.paymentStatus === 'unpaid' ? 0 : (order.payment?.amount || 0);
  const balanceDue  = Math.max(0, Math.round((order.total - alreadyPaid) * 100) / 100);

  if (balanceDue <= 0) {
    return next(new AppError('No outstanding balance on this order', 400));
  }

  // The payer pays from their own wallet. This resolved order.customer's
  // wallet first, which is only the payer's when the order is linked through
  // the account rather than the customer record.
  const orderUser = { customerId: req.user.customerId };
  if (!orderUser.customerId) {
    return next(new AppError('Customer wallet not found', 404));
  }

  const existingWallet = await Wallet.findOne({ customerId: orderUser.customerId });
  if (!existingWallet) return next(new AppError('Wallet not found. Please contact support.', 404));

  // Atomic check-and-debit — see payBalanceFromWallet for the reasoning.
  const wallet = await Wallet.findOneAndUpdate(
    { _id: existingWallet._id, balance: { $gte: balanceDue } },
    { $inc: { balance: -balanceDue } },
    { new: true }
  );

  if (!wallet) {
    return next(new AppError(
      `Insufficient wallet balance. Balance: ₦${existingWallet.balance.toLocaleString()}, Required: ₦${balanceDue.toLocaleString()}`,
      400
    ));
  }

  await WalletTransaction.create({
    walletId:     wallet._id,
    customerId:   orderUser.customerId,
    orderId:      order._id,
    type:         'debit',
    amount:       balanceDue,
    reason:       `Payment for order ${order.orderNumber}`,
    balanceAfter: wallet.balance,
    source:       'order',
  });

  // Mark order fully paid
  order.paymentStatus      = 'paid';
  order.payment.status     = 'paid';
  order.payment.method     = 'wallet';
  order.payment.amount     = order.total;
  order.payment.paidAt     = new Date();
  await order.save();

  await processReferralReward(order, 'paid', req.app.get('io'));

  const io = req.app.get('io');
  if (io) {
    io.to(`user-${req.user._id}`).emit('wallet:balance-updated', {
      balance: wallet.balance,
      transaction: { type: 'debit', amount: balanceDue, reason: `Payment for order ${order.orderNumber}` },
    });
    io.to(`order-${order._id}`).emit('order:updated', {
      orderId: order._id,
      paymentStatus: 'paid',
    });
    io.emit('leaderboard:updated');
  }

  res.status(200).json({
    success: true,
    message: `₦${balanceDue.toLocaleString()} paid from wallet. Order is now fully paid.`,
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

  // Ownership check for customers.
  //
  // order.customer is null on a walk-in that has not been linked to an account
  // yet, and those orders ARE surfaced to a matching customer by getOrders /
  // getOrder — so this used to dereference null and 500 on a live code path.
  // Same ownership rule as every other customer action (see customerIdentity).
  if (req.user.role === 'customer' && !customerCanAccessOrder(req.user, order)) {
    return next(new AppError('Not authorized to cancel this order', 403));
  }

  // Check if order can be cancelled
  if (['delivered', 'completed', 'cancelled'].includes(order.status)) {
    return next(new AppError('Order cannot be cancelled', 400));
  }

  const statusBeforeCancel = order.status;

  order.status = 'cancelled';
  order.notes = `Cancelled: ${reason}`;

  order.statusHistory.push({
    status: 'cancelled',
    updatedBy: req.user.id,
    actorRole: req.user.role,
    notes: reason,
  });

  await order.save();

  await logAudit({
    actorUserId: req.user.id,
    action: 'ORDER_CANCELLED',
    targetType: 'Order',
    targetId: order._id.toString(),
    before: { status: statusBeforeCancel },
    after: { status: 'cancelled' },
    metadata: { orderNumber: order.orderNumber, reason: reason || undefined, total: order.total },
  });

  // ── Reverse what the order consumed at checkout ───────────────────────────
  // Cancellation refunded the wallet but nothing else, so a customer lost every
  // loyalty point they had redeemed and a single-use promo code stayed burnt.
  // Both are reversed here; each is independent and must not block the other or
  // the cancellation itself, which is already persisted above.
  let pointsReturned = 0;
  if (order.loyaltyPointsRedeemed > 0 && order.customerId) {
    try {
      const restored = await Customer.findByIdAndUpdate(
        order.customerId,
        { $inc: { loyaltyPointsBalance: order.loyaltyPointsRedeemed } },
        { new: true }
      );
      if (restored) {
        pointsReturned = order.loyaltyPointsRedeemed;
        // { orderId, type } is unique, so 'reversal' coexists with the original
        // 'redeem' row and a double cancel cannot credit the points twice.
        await LoyaltyLedger.create({
          customerId:   order.customerId,
          orderId:      order._id,
          points:       pointsReturned,
          type:         'reversal',
          source:       'order',
          reason:       `Points returned — Order ${order.orderNumber} cancelled`,
          balanceAfter: restored.loyaltyPointsBalance,
        });
        order.loyaltyPointsRedeemed = 0;
        order.loyaltyDiscountAmount = 0;
        await order.save();
      }
    } catch (pointsErr) {
      if (pointsErr.code === 11000) {
        logger.info(`[cancelOrder] Points already reversed for ${order.orderNumber}`);
      } else {
        logger.error(`[cancelOrder] Point reversal failed for ${order.orderNumber}: ${pointsErr.message}`);
      }
    }
  }

  if (order.promoCodeId) {
    try {
      const removed = await PromoRedemption.findOneAndDelete({ orderId: order._id });
      if (removed) {
        // The code may have been auto-disabled when this redemption pushed it to
        // its usage limit — releasing the slot has to release the code too.
        const promo = await PromoCode.findById(order.promoCodeId);
        if (promo && promo.usageLimit && !promo.active) {
          const usage = await PromoRedemption.countDocuments({ promoCodeId: promo._id });
          if (usage < promo.usageLimit) {
            await PromoCode.findByIdAndUpdate(promo._id, { active: true });
          }
        }
      }
    } catch (promoErr) {
      logger.error(`[cancelOrder] Promo release failed for ${order.orderNumber}: ${promoErr.message}`);
    }
  }

  // Auto-refund wallet if paid via wallet
  const paidViaWallet = order.payment?.method === 'wallet' && order.paymentStatus === 'paid';
  const refundAmount = order.payment?.amount || order.total || 0;
  let walletRefundIssued = false;

  if (paidViaWallet && refundAmount > 0) {
    const orderUser = await User.findById(order.customer).select('customerId').lean();
    if (orderUser?.customerId) {
      const wallet = await Wallet.findOneAndUpdate(
        { customerId: orderUser.customerId },
        { $inc: { balance: refundAmount } },
        { new: true }
      );
      if (wallet) {
        await WalletTransaction.create({
          walletId: wallet._id,
          customerId: orderUser.customerId,
          orderId: order._id,
          type: 'credit',
          amount: refundAmount,
          reason: `Order Cancellation Refund — ${order.orderNumber}`,
          balanceAfter: wallet.balance,
          source: 'order',
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

  // ── Money taken by a method we cannot refund automatically ────────────────
  // Only wallet payments reverse themselves. A Paystack / cash / POS / transfer
  // order used to be cancelled with paymentStatus left at 'paid' and no record
  // anywhere that the business owes the money back. The status is left honest —
  // the customer really did pay — but the obligation is now recorded and raised
  // so it cannot be settled silently.
  if (!walletRefundIssued && order.paymentStatus === 'paid' && refundAmount > 0) {
    await logAudit({
      actorUserId: req.user.id,
      action: 'REFUND_DUE',
      targetType: 'Order',
      targetId: order._id.toString(),
      before: { paymentStatus: 'paid', method: order.payment?.method },
      after: { paymentStatus: 'paid', refundOutstanding: refundAmount },
      metadata: {
        orderNumber: order.orderNumber,
        amount: refundAmount,
        method: order.payment?.method,
        note: 'Order cancelled after payment — manual refund required',
      },
    });
    logger.warn(
      `[cancelOrder] Manual refund owed on ${order.orderNumber}: ` +
      `₦${refundAmount} paid by ${order.payment?.method || 'unknown'}`
    );
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
  const manualRefundDue = !walletRefundIssued && order.paymentStatus === 'paid' && refundAmount > 0;
  await notify(cancelIo, {
    type: 'order_cancelled',
    title: manualRefundDue ? '⚠️ Order Cancelled — Refund Due' : 'Order Cancelled',
    body: manualRefundDue
      ? `Order ${order.orderNumber} was cancelled after payment. ₦${refundAmount.toLocaleString()} paid by ${order.payment?.method || 'unknown'} must be refunded manually. Reason: ${reason || 'not specified'}.`
      : `Order ${order.orderNumber} has been cancelled. Reason: ${reason || 'not specified'}.`,
    room: 'admin',
    metadata: { orderId: order._id, orderNumber: order.orderNumber, reason, refundDue: manualRefundDue ? refundAmount : 0 },
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
    data: {
      order,
      walletRefundIssued,
      refundAmount: walletRefundIssued ? refundAmount : 0,
      pointsReturned,
      manualRefundDue: manualRefundDue ? refundAmount : 0,
    },
  });
});

// ─── Order line items ────────────────────────────────────────────────────────
// These two used to read and write a standalone `OrderItem` collection that
// nothing else in the system ever read. Line items actually live in the embedded
// `order.items` array, so an "added" item never appeared on the order, never
// reached a receipt and never changed the total — while the route carried no
// authorize() at all. Both now operate on the real array, reprice from the DB
// the same way createOrder does, and recalculate the order total.
//
// Helper: rebuild pricing from the order's current items, preserving every
// server-derived component already settled on this order.
async function recalculateOrderTotal(order) {
  const previousTotal = order.total || 0;
  const pricing = calculateOrderPricing(
    order.items,
    order.pricing?.pickupFee   || 0,
    order.pricing?.deliveryFee || 0,
    order.pricing?.discount    || 0,
    // Service-level surcharge is a percentage of the item subtotal, so it has to
    // move with the items rather than be carried over as a frozen figure.
    Math.round((order.items.reduce((a, i) => a + (i.unitPrice || 0) * (i.quantity || 1), 0))
      * (order.serviceLevelPercentage || 0) / 100 * 100) / 100,
    order.pricing?.addOnsFee || 0
  );
  order.pricing = pricing;
  order.total   = pricing.total;
  return { previousTotal, newTotal: pricing.total };
}

// @desc    Add an item to an order
// @route   POST /api/v1/orders/:id/items
// @access  Private (Staff/Admin/Manager)
exports.addOrderItem = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  // Editing an order's contents is a counter action, matching PUT /orders/:id
  if (req.user.role === 'customer') {
    return next(new AppError('Not authorized to edit order items', 403));
  }

  if (['completed', 'delivered', 'cancelled'].includes(order.status)) {
    return next(new AppError('Cannot edit a completed, delivered, or cancelled order', 400));
  }

  const { itemType, categoryId, serviceType, serviceName, description, condition, careType } = req.body;
  const quantity = parseInt(req.body.quantity, 10);

  if (!Number.isFinite(quantity) || quantity < 1) {
    return next(new AppError('Quantity must be a whole number of at least 1', 400, ERROR_CODES.VALIDATION_ERROR));
  }

  // Price from the DB — never from the request body
  let unitPrice = 0;
  let categoryName;
  if (categoryId) {
    const category = await ServiceCategory.findById(categoryId).select('basePrice name').lean();
    if (!category) {
      return next(new AppError('Service category not found', 404));
    }
    categoryName = category.name;
    unitPrice = Math.round(category.basePrice * (CARE_TYPE_MULTIPLIERS[serviceType] ?? 1));
  } else if (req.user.role !== 'customer' && req.body.unitPrice !== undefined) {
    // Counter-entered item with no catalogue category — staff set the price,
    // clamped so it can never be negative.
    const manual = Number(req.body.unitPrice);
    unitPrice = Number.isFinite(manual) && manual > 0 ? Math.round(manual) : 0;
  }

  order.items.push({
    itemType: itemType || categoryName || 'Item',
    serviceType,
    serviceName,
    quantity,
    unitPrice,
    total: unitPrice * quantity,
    careType,
    categoryId,
    categoryName,
    description,
    condition,
  });

  const { previousTotal, newTotal } = await recalculateOrderTotal(order);
  order.lastUpdatedById = req.user.id;
  await order.save();

  await logAudit({
    actorUserId: req.user.id,
    action: 'ORDER_ITEM_ADDED',
    targetType: 'Order',
    targetId: order._id.toString(),
    before: { total: previousTotal },
    after: { total: newTotal },
    metadata: { orderNumber: order.orderNumber, itemType: itemType || categoryName, quantity, unitPrice },
  });

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:updated', { orderId: order._id, total: order.total });
  }

  res.status(201).json({
    success: true,
    message: 'Order item added successfully',
    data: { order },
  });
});

// @desc    Remove an item from an order
// @route   DELETE /api/v1/orders/:id/items/:itemId
// @access  Private (Staff/Admin/Manager)
exports.removeOrderItem = asyncHandler(async (req, res, next) => {
  const order = await Order.findById(req.params.id);

  if (!order) {
    return next(new AppError('Order not found', 404));
  }

  if (req.user.role === 'customer') {
    return next(new AppError('Not authorized to edit order items', 403));
  }

  if (['completed', 'delivered', 'cancelled'].includes(order.status)) {
    return next(new AppError('Cannot edit a completed, delivered, or cancelled order', 400));
  }

  const item = order.items.id(req.params.itemId);
  if (!item) {
    return next(new AppError('Order item not found', 404));
  }

  const removed = { itemType: item.itemType, quantity: item.quantity, unitPrice: item.unitPrice };
  item.deleteOne();

  const { previousTotal, newTotal } = await recalculateOrderTotal(order);
  order.lastUpdatedById = req.user.id;
  await order.save();

  await logAudit({
    actorUserId: req.user.id,
    action: 'ORDER_ITEM_REMOVED',
    targetType: 'Order',
    targetId: order._id.toString(),
    before: { total: previousTotal, ...removed },
    after: { total: newTotal },
    metadata: { orderNumber: order.orderNumber },
  });

  const io = req.app.get('io');
  if (io) {
    io.to(`order-${order._id}`).emit('order:updated', { orderId: order._id, total: order.total });
  }

  res.status(200).json({
    success: true,
    message: 'Order item removed successfully',
    data: { order },
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

  // Ownership guard — every sibling handler (getOrderMedia, addOrderItem,
  // removeOrderItem) has this; only this one was missing it, which let any
  // signed-in customer attach media and notes to anyone else's order.
  if (req.user.role === 'customer' && order.customer?.toString() !== req.user.id) {
    return next(new AppError('Not authorized', 403));
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

  if (req.user.role === 'customer' && order.customer?.toString() !== req.user.id) {
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
    { $match: { customer: new mongoose.Types.ObjectId(userId), status: { $nin: ['cancelled', 'draft'] } } },
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

// @desc    Get customer points leaderboard (weekly + monthly)
// @route   GET /api/v1/orders/leaderboard
// @access  Private
exports.getLeaderboard = asyncHandler(async (req, res) => {
  const now = new Date();

  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  weekStart.setUTCHours(0, 0, 0, 0);

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const TOP_N = 50;

  const buildPipeline = (dateStart) => [
    {
      $match: {
        type: 'earn',
        customerId: { $ne: null },
        createdAt: { $gte: dateStart },
      },
    },
    {
      $group: {
        _id: '$customerId',
        totalPoints: { $sum: '$points' },
      },
    },
    { $sort: { totalPoints: -1 } },
    {
      $lookup: {
        from: 'customers',
        localField: '_id',
        foreignField: '_id',
        as: 'customer',
      },
    },
    { $unwind: '$customer' },
    // The leaderboard is shown to every customer, so a deactivated account's
    // name is not published on it. Filtered before $limit so the board still
    // fills its places. Their ledger rows are untouched — this is display only.
    { $match: { 'customer.status': { $ne: 'suspended' } } },
    { $limit: TOP_N },
    {
      $project: {
        _id: 0,
        customerId: '$_id',
        name: '$customer.name',
        totalPoints: 1,
      },
    },
  ];

  const [weeklyRaw, monthlyRaw] = await Promise.all([
    LoyaltyLedger.aggregate(buildPipeline(weekStart)),
    LoyaltyLedger.aggregate(buildPipeline(monthStart)),
  ]);

  const addRank = (arr) => arr.map((entry, i) => ({ ...entry, rank: i + 1 }));
  const weekly  = addRank(weeklyRaw);
  const monthly = addRank(monthlyRaw);

  let myWeeklyRank  = null;
  let myMonthlyRank = null;

  if (req.user.role === 'customer' && req.user.customerId) {
    const myId = req.user.customerId.toString();

    const getMyRank = async (dateStart) => {
      const results = await LoyaltyLedger.aggregate([
        {
          $match: {
            type: 'earn',
            customerId: { $ne: null },
            createdAt: { $gte: dateStart },
          },
        },
        {
          $group: {
            _id: '$customerId',
            totalPoints: { $sum: '$points' },
          },
        },
        { $sort: { totalPoints: -1 } },
      ]);
      const idx = results.findIndex((r) => r._id.toString() === myId);
      return idx === -1 ? null : { rank: idx + 1, totalPoints: results[idx].totalPoints };
    };

    [myWeeklyRank, myMonthlyRank] = await Promise.all([
      getMyRank(weekStart),
      getMyRank(monthStart),
    ]);
  }

  res.status(200).json({
    success: true,
    data: { weekly, monthly, myWeeklyRank, myMonthlyRank },
  });
});

// @desc    Backfill walk-in order phone normalization and user linking
// @route   POST /api/v1/orders/backfill-walkin
// @access  Private (Admin only)
exports.backfillWalkIn = asyncHandler(async (req, res) => {
  // Previously linked walk-in orders to any account whose (unverified) phone
  // matched — the same leak as the startup job. It now runs the phone
  // normalization only; linking goes through customer records and verified
  // identities (utils/migrations/linkWalkInCustomers).
  await require('../utils/backfillWalkIn.js')();
  res.status(200).json({
    success: true,
    message: 'Walk-in phone numbers normalized. Orders are linked to customers through customer records — run the linkWalkInCustomers migration for historical orders.',
    data: { linkedCount: 0 },
  });
});
