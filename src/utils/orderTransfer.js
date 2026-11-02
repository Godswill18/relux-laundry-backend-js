// ─── Order ownership transfer ───────────────────────────────────────────────
//
// Moves ONE order to another customer account when staff change the phone on
// it. An order is owned through two fields — `customer` (portal User) and
// `customerId` (Customer record) — and My Orders matches either, so both move
// together. `walkInCustomer` is only the contact snapshot.
//
// Verification: a staff member typing a number proves nothing, and the phone on
// an account is itself unverified (isPhoneVerified is never set; there is no SMS
// provider). So the number only FINDS the account. The move is authorised by a
// code sent to that account's verified EMAIL, which proves whoever is at the
// counter controls the destination account. The code is bound to this request,
// order, phone and account, so it can't authorise anything else.
//
// What never changes: payments, wallets, totals, status, SLA, items, collections,
// history. Accounts are never merged and neither account's details are edited.

const crypto = require('crypto');
const Order = require('../models/Order.js');
const OrderTransfer = require('../models/OrderTransfer.js');
const User = require('../models/User.js');
const Customer = require('../models/Customer.js');
const WalletTransaction = require('../models/WalletTransaction.js');
const AuditLog = require('../models/AuditLog.js');
const AppError = require('./appError.js');
const ERROR_CODES = require('./errorCodes.js');
const logger = require('./logger.js');
const notify = require('./notify.js');
const sendEmail = require('./sendEmail.js');
const normalizePhone = require('./normalizePhone.js');
const ensureCustomer = require('./ensureCustomer.js');
const { logAudit } = require('./auditLogger.js');
const { phoneVariants, maskEmail, maskPhone } = require('./customerIdentity.js');
const { withOptionalTransaction } = require('./orderFulfilment.js');
const { getRolePermissionsFromDB } = require('./rolePermissions.js');
const { TERMINAL_STORED_VALUES } = require('./orderStatus.js');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const OPEN_STATES = ['PENDING_VERIFICATION', 'PENDING_ACCOUNT'];

const invalid = (m) => new AppError(m, 400, ERROR_CODES.VALIDATION_ERROR);

const hashCode = (t, code) => crypto
  .createHmac('sha256', process.env.JWT_SECRET)
  .update(`order-transfer:${t._id}:${t.orderId}:${t.toPhone}:${t.toUserId}:${code}`)
  .digest('hex');

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

/** Backend gate: EDIT_ORDER, live from Roles & Permissions. Not every staff role has it. */
async function canTransferOrders(user) {
  if (user?.role === 'developer') return true;
  return (await getRolePermissionsFromDB(user?.role)).includes('EDIT_ORDER');
}

/** The minimum staff need to confirm the right person, nothing more. */
function maskAccount(user) {
  const [first, ...rest] = String(user.name || '').trim().split(/\s+/);
  return {
    name: rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first || 'Customer',
    phone: maskPhone(user.phone || ''),
    email: maskEmail(user.email),
  };
}

/**
 * Every customer account this number points at: directly, or through a Customer
 * record holding it. Different accounts → the caller must not guess.
 */
async function findAccounts(rawPhone) {
  const variants = phoneVariants(rawPhone);
  const select = 'name email phone customerId isActive emailVerified role';
  const [byPhone, records] = await Promise.all([
    User.find({ role: 'customer', phone: { $in: variants } }).select(select),
    Customer.find({ phone: { $in: variants } }).select('_id').lean(),
  ]);
  const viaRecord = records.length
    ? await User.find({ role: 'customer', customerId: { $in: records.map((r) => r._id) } }).select(select)
    : [];
  const distinct = new Map([...byPhone, ...viaRecord].map((u) => [String(u._id), u]));
  return [...distinct.values()];
}

// Usable destination: signed-up, email proven, not deactivated.
const isEligible = (u) => u.isActive !== false && u.emailVerified === true && !!u.email;

async function currentPhone(order) {
  if (order.walkInCustomer?.phone) return order.walkInCustomer.phone;
  const ownerId = order.customer?._id ?? order.customer;
  if (!ownerId) return null;
  const owner = await User.findById(ownerId).select('phone').lean();
  return owner?.phone || null;
}

/**
 * A cancellation refund goes to the wallet of whoever owns the order. If it was
 * paid from A's wallet and moved to B, that refund would hand A's money to B —
 * so a wallet-paid order can't move while it can still be cancelled.
 */
async function assertNoWalletExposure(order) {
  if (TERMINAL_STORED_VALUES.includes(order.status)) return;
  const debited = await WalletTransaction.exists({ orderId: order._id, type: 'debit', source: 'order' });
  if (debited || (order.payment?.method === 'wallet' && order.paymentStatus === 'paid')) {
    throw new AppError(
      "This order was paid from the customer's wallet, so it can't be transferred while it can still be cancelled — a refund would go to the wrong account.",
      409,
      'ORDER_TRANSFER_WALLET_PAID'
    );
  }
}

async function sendCode(transfer, target) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const now = new Date();
  await OrderTransfer.updateOne(
    { _id: transfer._id },
    {
      $set: { codeHash: hashCode(transfer, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS), lastSentAt: now, attempts: 0, channel: 'email' },
      $inc: { codesSent: 1 },
    }
  );
  await sendEmail({
    to: target.email,
    subject: 'Your Relux Laundry order transfer code',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px;">
        <h2 style="color:#1d4ed8;margin-bottom:8px;">Relux Laundry</h2>
        <h3>Move order ${transfer.orderNumber} to your account</h3>
        <p>Relux staff are moving this order to your account. If you asked for this, give them this code. It expires in <strong>10 minutes</strong>.</p>
        <div style="text-align:center;margin:32px 0;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#1d4ed8;">${code}</span>
        </div>
        <p>If you didn't ask for this, don't share the code — nothing changes without it.</p>
      </div>`,
  });
}

function closeFields(status, extra = {}) {
  return { $set: { status, ...extra }, $unset: { openOrderId: 1 } };
}

const publicView = (t) => (t ? {
  id: t._id, status: t.status, toPhone: maskPhone(t.toPhone), expiresAt: t.expiresAt || null, requestedAt: t.createdAt,
} : null);

/**
 * Start (or resume) a transfer. Every path that changes an order's phone comes
 * here. Returns { outcome, message, account?, transfer? } for the staff UI.
 */
async function requestTransfer({ orderId, phone, actor }) {
  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404);

  const toPhone = normalizePhone(typeof phone === 'string' ? phone : '');
  if (!toPhone) throw invalid('Enter a valid phone number, with the country code if it is not Nigerian.');

  const previousPhone = await currentPhone(order);
  const open = await OrderTransfer.findOne({ openOrderId: order._id });
  if (open && open.toPhone !== toPhone) {
    throw new AppError('A transfer to another number is already pending on this order. Cancel it first.', 409, 'ORDER_TRANSFER_PENDING');
  }

  if (!open && previousPhone && normalizePhone(previousPhone) === toPhone) {
    return { outcome: 'unchanged', message: 'This order already has that phone number.' };
  }

  const accounts = await findAccounts(toPhone);

  if (accounts.length > 1) {
    await logAudit({
      actorUserId: actor.id, action: 'ORDER_TRANSFER_CONFLICT', targetType: 'Order', targetId: order._id.toString(),
      metadata: { orderNumber: order.orderNumber, toPhone, accountIds: accounts.map((a) => String(a._id)) },
    });
    return { outcome: 'conflict', message: 'Multiple customer records match this phone number. Automatic transfer has been stopped for security.' };
  }

  const target = accounts[0] && isEligible(accounts[0]) ? accounts[0] : null;
  const ownerId = order.customer ? String(order.customer) : null;
  const sameOwner = target && (
    String(target._id) === ownerId
    || (target.customerId && order.customerId && String(target.customerId) === String(order.customerId))
  );

  // The number is the current owner's own: a contact correction, not a transfer.
  if (sameOwner) {
    if (open) await OrderTransfer.updateOne({ _id: open._id }, closeFields('CANCELLED', { failureReason: 'number belongs to the current owner' }));
    await updateContactPhone(order, toPhone, previousPhone, actor);
    return { outcome: 'contact_updated', message: 'Phone number updated. This number already belongs to the customer on this order, so no transfer was needed.' };
  }

  if (!target) {
    const message = 'No registered account was found for this phone number. The transfer can be completed after the customer registers and verifies this number.';
    if (open) return { outcome: 'pending_account', message, transfer: publicView(open) };
    const transfer = await createOpen({ order, toPhone, previousPhone, actor, status: 'PENDING_ACCOUNT' });
    // With no portal owner there's nobody to protect, and a mistyped walk-in
    // number must stay correctable: the contact updates, ownership doesn't.
    if (!order.customer) await updateContactPhone(order, toPhone, previousPhone, actor);
    return { outcome: 'pending_account', message, transfer: publicView(transfer) };
  }

  await assertNoWalletExposure(order);

  let transfer = open;
  if (!transfer) {
    transfer = await createOpen({ order, toPhone, previousPhone, actor, status: 'PENDING_VERIFICATION', target });
  } else {
    if (String(transfer.toUserId || '') && String(transfer.toUserId) !== String(target._id)) {
      await OrderTransfer.updateOne({ _id: transfer._id }, closeFields('FAILED', { failureReason: 'destination account changed' }));
      throw new AppError('The account for this number changed. Start the transfer again.', 409, 'ORDER_TRANSFER_STALE');
    }
    if (transfer.status === 'PENDING_ACCOUNT') {
      // Customer has since registered: this is the resume path.
      await OrderTransfer.updateOne({ _id: transfer._id }, { $set: { status: 'PENDING_VERIFICATION', toUserId: target._id, toCustomerId: target.customerId } });
      transfer.status = 'PENDING_VERIFICATION';
      transfer.toUserId = target._id;
    } else {
      if (transfer.lastSentAt && Date.now() - transfer.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
        throw new AppError('A code was just sent. Wait a minute before sending another.', 429);
      }
      if ((transfer.codesSent || 0) >= MAX_CODES) {
        await OrderTransfer.updateOne({ _id: transfer._id }, closeFields('FAILED', { failureReason: 'too many codes' }));
        throw new AppError('Too many codes were sent for this transfer. Start again later.', 429);
      }
    }
  }

  try {
    await sendCode(transfer, target);
  } catch (err) {
    logger.error(`[orderTransfer] code email failed for ${order.orderNumber}: ${err.message}`);
    throw new AppError('The verification code could not be sent. Try again.', 502);
  }

  const account = maskAccount(target);
  return {
    outcome: 'pending_verification',
    message: 'An existing customer account was found for this phone number. After the customer verifies ownership, this order will be transferred to that account.',
    account,
    sentTo: account.email,
    transfer: publicView(await OrderTransfer.findById(transfer._id)),
  };
}

async function createOpen({ order, toPhone, previousPhone, actor, status, target }) {
  let transfer;
  try {
    transfer = await OrderTransfer.create({
      orderId: order._id,
      openOrderId: order._id,
      orderNumber: order.orderNumber,
      status,
      fromUserId: order.customer || undefined,
      fromCustomerId: order.customerId || undefined,
      previousPhone: previousPhone || undefined,
      toPhone,
      toUserId: target?._id,
      toCustomerId: target?.customerId,
      requestedBy: actor.id,
    });
  } catch (err) {
    if (err.code === 11000) throw new AppError('A transfer is already pending on this order.', 409, 'ORDER_TRANSFER_PENDING');
    throw err;
  }
  await logAudit({
    actorUserId: actor.id, action: 'ORDER_TRANSFER_REQUESTED', targetType: 'Order', targetId: order._id.toString(),
    metadata: { orderNumber: order.orderNumber, status, previousPhone, toPhone, toUserId: target?._id },
  });
  return transfer;
}

async function updateContactPhone(order, toPhone, previousPhone, actor) {
  if (order.walkInCustomer) {
    await Order.updateOne({ _id: order._id }, { $set: { 'walkInCustomer.phone': toPhone } });
  }
  await logAudit({
    actorUserId: actor.id, action: 'ORDER_CONTACT_PHONE_UPDATED', targetType: 'Order', targetId: order._id.toString(),
    before: { phone: previousPhone }, after: { phone: toPhone }, metadata: { orderNumber: order.orderNumber },
  });
}

async function fail(transfer, reason, actor) {
  await OrderTransfer.updateOne({ _id: transfer._id, openOrderId: transfer.orderId }, closeFields('FAILED', { failureReason: reason }));
  await logAudit({
    actorUserId: actor?.id, action: 'ORDER_TRANSFER_FAILED', targetType: 'Order', targetId: String(transfer.orderId),
    metadata: { orderNumber: transfer.orderNumber, transferId: String(transfer._id), reason },
  });
}

/** Check the code, then move the order. All or nothing. */
async function verifyTransfer({ orderId, code, actor, io }) {
  const transfer = await OrderTransfer.findOne({ openOrderId: orderId }).select('+codeHash');

  if (!transfer) {
    const done = await OrderTransfer.findOne({ orderId, status: 'COMPLETED' }).sort('-completedAt').lean();
    if (done) return { outcome: 'already_transferred', message: 'This order was already transferred.' };
    throw new AppError('There is no pending transfer on this order.', 404);
  }
  if (transfer.status !== 'PENDING_VERIFICATION' || !transfer.codeHash) {
    throw new AppError('This transfer is not waiting for a code.', 409);
  }
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalid('Enter the 6-digit code.');
  if (!transfer.expiresAt || transfer.expiresAt.getTime() <= Date.now()) {
    throw invalid('That code has expired. Send a new one.');
  }

  // Count the attempt atomically BEFORE comparing, so parallel guesses can't share one.
  const counted = await OrderTransfer.findOneAndUpdate(
    { _id: transfer._id, status: 'PENDING_VERIFICATION', attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!counted) {
    await fail(transfer, 'too many incorrect codes', actor);
    throw new AppError('Too many incorrect codes. Start the transfer again.', 429);
  }
  if (!safeEqual(transfer.codeHash, hashCode(transfer, code))) {
    if (counted.attempts >= MAX_ATTEMPTS) await fail(transfer, 'too many incorrect codes', actor);
    throw invalid('That code is incorrect.');
  }

  // Re-read everything: the code proves consent, not that nothing changed since.
  const target = await User.findById(transfer.toUserId);
  if (!target || !isEligible(target)) {
    await fail(transfer, 'destination account no longer eligible', actor);
    throw new AppError('The destination account can no longer receive this order.', 409);
  }
  const stillMatches = await findAccounts(transfer.toPhone);
  if (stillMatches.length !== 1 || String(stillMatches[0]._id) !== String(target._id)) {
    await fail(transfer, 'phone no longer maps to exactly this account', actor);
    throw new AppError('This phone number no longer matches that account. Start the transfer again.', 409);
  }
  if (!target.customerId) await ensureCustomer(target);
  if (!target.customerId) throw new AppError('The destination account has no customer record.', 409);

  const order = await Order.findById(orderId);
  if (!order) throw new AppError('Order not found', 404);
  await assertNoWalletExposure(order);

  const now = new Date();
  const before = {
    customer: order.customer || null, customerId: order.customerId || null, phone: transfer.previousPhone || null,
  };
  const after = { customer: target._id, customerId: target.customerId, phone: target.phone || transfer.toPhone };

  let lostRace = false;
  try {
    await withOptionalTransaction(async (session) => {
      const opts = session ? { session } : {};

      // Conditional claim: of two racing verifications, only one gets past here.
      const claimed = await OrderTransfer.findOneAndUpdate(
        { _id: transfer._id, status: 'PENDING_VERIFICATION', openOrderId: transfer.orderId },
        {
          ...closeFields('COMPLETED', { verifiedAt: now, completedAt: now, toCustomerId: target.customerId }),
          $unset: { openOrderId: 1, codeHash: 1 },
        },
        { new: true, ...opts }
      );
      if (!claimed) {
        lostRace = true;
        throw new AppError('This transfer has already been processed.', 409);
      }

      // Only if the owner is still who the request recorded.
      const set = { customer: target._id, customerId: target.customerId };
      if (order.walkInCustomer?.name || order.walkInCustomer?.phone) {
        set['walkInCustomer.name'] = target.name;
        set['walkInCustomer.phone'] = after.phone;
        set['walkInCustomer.email'] = target.email;
      }
      const moved = await Order.updateOne(
        { _id: order._id, customer: transfer.fromUserId || null, customerId: transfer.fromCustomerId || null },
        { $set: set },
        { ...opts, timestamps: false }
      );
      if (moved.modifiedCount !== 1) throw new AppError('This order changed while the transfer was in progress. Start again.', 409);

      await AuditLog.create([{
        actorUserId: actor.id,
        action: 'ORDER_TRANSFER_COMPLETED',
        targetType: 'Order',
        targetId: order._id.toString(),
        before,
        after,
        metadata: {
          orderNumber: order.orderNumber,
          transferId: String(transfer._id),
          requestedBy: String(transfer.requestedBy),
          verificationMethod: 'email_otp_to_destination_account',
          verifiedAt: now,
          transferredAt: now,
          result: 'COMPLETED',
        },
      }], opts);
    });
  } catch (err) {
    // The other verification won: its result stands, touch nothing.
    if (lostRace) throw err;
    // With a transaction the rollback left the request open, so close it. Without
    // one (standalone MongoDB, dev only) the claim landed, so turn it back.
    await OrderTransfer.updateOne(
      { _id: transfer._id, status: 'COMPLETED' },
      { $set: { status: 'FAILED', failureReason: err.message }, $unset: { completedAt: 1, verifiedAt: 1 } }
    ).catch(() => {});
    await fail(transfer, err.message, actor).catch(() => {});
    if (err instanceof AppError) throw err;
    logger.error(`[orderTransfer] failed for ${order.orderNumber}: ${err.message}`);
    throw new AppError('The transfer could not be completed. Nothing was changed.', 500);
  }

  // After the commit: a failed notification must not undo a completed transfer.
  try {
    await notify(io, {
      type: 'order_status_updated',
      title: 'Order added to your account',
      body: `Order ${order.orderNumber} is now in your account.`,
      customerId: String(target.customerId),
      metadata: { orderId: order._id, orderNumber: order.orderNumber, status: order.status },
    });
  } catch (err) {
    logger.error(`[orderTransfer] notification failed for ${order.orderNumber}: ${err.message}`);
  }
  if (io) {
    // Open order lists (both customers', staff) already refetch on this event.
    io.emit('order:status-updated', { orderId: order._id, status: order.status });
    io.emit('order:updated', { orderId: order._id });
  }

  return {
    outcome: 'completed',
    message: 'Order successfully transferred to the new customer account.',
    account: maskAccount(target),
  };
}

async function cancelTransfer({ orderId, actor }) {
  const transfer = await OrderTransfer.findOneAndUpdate(
    { openOrderId: orderId },
    { ...closeFields('CANCELLED'), $unset: { openOrderId: 1, codeHash: 1 } },
    { new: true }
  );
  if (!transfer) throw new AppError('There is no pending transfer on this order.', 404);
  await logAudit({
    actorUserId: actor.id, action: 'ORDER_TRANSFER_CANCELLED', targetType: 'Order', targetId: String(orderId),
    metadata: { orderNumber: transfer.orderNumber, transferId: String(transfer._id) },
  });
  return { outcome: 'cancelled', message: 'The transfer was cancelled. The order stays where it is.' };
}

async function getOpenTransfer(orderId) {
  return publicView(await OrderTransfer.findOne({ openOrderId: orderId }).lean());
}

module.exports = {
  canTransferOrders, requestTransfer, verifyTransfer, cancelTransfer, getOpenTransfer, OPEN_STATES, MAX_ATTEMPTS,
};
