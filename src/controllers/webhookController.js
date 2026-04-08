const crypto = require('crypto');
const { Webhook } = require('svix');
const User = require('../models/User.js');
const PaystackTransaction = require('../models/PaystackTransaction.js');
const { processSuccessfulPaystackPayment, getPaystackSecretKey } = require('./paymentController.js');
const logger = require('../utils/logger.js');

// Clerk webhook handler
exports.handleClerkWebhook = async (req, res) => {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    logger.error('CLERK_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const svix_id = req.headers['svix-id'];
  const svix_timestamp = req.headers['svix-timestamp'];
  const svix_signature = req.headers['svix-signature'];

  if (!svix_id || !svix_timestamp || !svix_signature) {
    return res.status(400).json({ error: 'Missing Svix headers' });
  }

  const wh = new Webhook(WEBHOOK_SECRET);
  let event;

  try {
    event = wh.verify(req.body, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature,
    });
  } catch (err) {
    logger.error(`Webhook verification failed: ${err.message}`);
    return res.status(400).json({ error: 'Webhook verification failed' });
  }

  const { type, data } = event;

  try {
    switch (type) {
      case 'user.created': {
        const { id, email_addresses, phone_numbers, first_name, last_name } = data;
        const primaryEmail = email_addresses?.find(
          (e) => e.id === data.primary_email_address_id
        );
        const primaryPhone = phone_numbers?.find(
          (p) => p.id === data.primary_phone_number_id
        );

        // Check if a user with this email or phone already exists (link accounts)
        let existingUser = null;
        if (primaryEmail?.email_address) {
          existingUser = await User.findOne({ email: primaryEmail.email_address });
        }
        if (!existingUser && primaryPhone?.phone_number) {
          existingUser = await User.findOne({ phone: primaryPhone.phone_number });
        }

        if (existingUser) {
          existingUser.clerkId = id;
          existingUser.authProvider = 'clerk';
          await existingUser.save({ validateBeforeSave: false });
          logger.info(`Linked existing user ${existingUser._id} to Clerk ${id}`);
        } else {
          await User.create({
            clerkId: id,
            authProvider: 'clerk',
            name: [first_name, last_name].filter(Boolean).join(' ') || 'Customer',
            email: primaryEmail?.email_address,
            phone: primaryPhone?.phone_number,
            role: 'customer',
            isPhoneVerified:
              primaryPhone?.verification?.status === 'verified',
          });
          logger.info(`Created new user from Clerk webhook: ${id}`);
        }
        break;
      }

      case 'user.updated': {
        const { id, email_addresses, phone_numbers, first_name, last_name } = data;
        const primaryEmail = email_addresses?.find(
          (e) => e.id === data.primary_email_address_id
        );
        const primaryPhone = phone_numbers?.find(
          (p) => p.id === data.primary_phone_number_id
        );

        const user = await User.findOne({ clerkId: id });
        if (user) {
          user.name =
            [first_name, last_name].filter(Boolean).join(' ') || user.name;
          if (primaryEmail?.email_address) user.email = primaryEmail.email_address;
          if (primaryPhone?.phone_number) user.phone = primaryPhone.phone_number;
          user.isPhoneVerified =
            primaryPhone?.verification?.status === 'verified' ||
            user.isPhoneVerified;
          await user.save({ validateBeforeSave: false });
          logger.info(`Updated user from Clerk webhook: ${id}`);
        } else {
          logger.warn(`Clerk user.updated for unknown clerkId: ${id}`);
        }
        break;
      }

      case 'user.deleted': {
        const { id } = data;
        const user = await User.findOne({ clerkId: id });
        if (user) {
          user.isActive = false;
          await user.save({ validateBeforeSave: false });
          logger.info(`Deactivated user from Clerk webhook: ${id}`);
        }
        break;
      }

      default:
        logger.info(`Unhandled Clerk webhook event type: ${type}`);
    }
  } catch (err) {
    logger.error(`Error processing Clerk webhook ${type}: ${err.message}`);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  res.status(200).json({ received: true });
};

// ============================================================================
// PAYSTACK WEBHOOK HANDLER
// POST /api/webhooks/paystack
// Paystack sends raw JSON with X-Paystack-Signature header (HMAC-SHA512)
// ============================================================================

exports.handlePaystackWebhook = async (req, res) => {
  // Always acknowledge quickly — Paystack retries on non-200
  res.status(200).json({ received: true });

  // Prefer DB-stored key over env var (same logic as payment controller)
  const secret = await getPaystackSecretKey();
  if (!secret || secret === 'your-paystack-secret-key') {
    logger.warn('Paystack webhook received but secret key is not configured');
    return;
  }

  // Verify HMAC-SHA512 signature
  const signature = req.headers['x-paystack-signature'];
  const rawBody   = req.body; // Buffer (express.raw middleware)
  const expected  = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  if (signature !== expected) {
    logger.warn('Paystack webhook: invalid signature — request ignored');
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    logger.error('Paystack webhook: failed to parse body', err.message);
    return;
  }

  const { event: eventType, data } = event;
  logger.info(`Paystack webhook received: ${eventType} | ref: ${data?.reference}`);

  try {
    if (eventType === 'charge.success') {
      const { reference, amount, status, gateway_response } = data;

      const transaction = await PaystackTransaction.findOne({ reference });
      if (!transaction) {
        logger.warn(`Paystack webhook: no transaction for reference ${reference}`);
        return;
      }

      if (transaction.webhookProcessed) {
        logger.info(`Paystack webhook: ${reference} already processed — skipped`);
        return;
      }

      // Verify amount matches (Paystack sends kobo; our DB stores NGN)
      const expectedKobo = Math.round(transaction.amount * 100);
      if (amount !== expectedKobo) {
        logger.error(`Paystack webhook: amount mismatch for ${reference} — expected ${expectedKobo} kobo, got ${amount}`);
        return;
      }

      const io = req.app ? req.app.get('io') : null;
      await processSuccessfulPaystackPayment(transaction, data, io);
      logger.info(`Paystack webhook: successfully processed ${reference}`);

    } else if (eventType === 'charge.failed') {
      const { reference, gateway_response } = data;
      const transaction = await PaystackTransaction.findOne({ reference });
      if (transaction && !transaction.webhookProcessed) {
        transaction.status = 'failed';
        transaction.failureReason = gateway_response || 'Payment failed';
        transaction.paystackData = data;
        await transaction.save();
        logger.info(`Paystack webhook: marked ${reference} as failed`);

        // Notify admin
        const io = req.app ? req.app.get('io') : null;
        if (io) {
          io.to('payments').emit('payment:paystack-failed', {
            transactionId: transaction._id,
            reference,
            amount: transaction.amount,
            reason: transaction.failureReason,
          });
        }
      }
    } else {
      logger.info(`Paystack webhook: unhandled event type ${eventType}`);
    }
  } catch (err) {
    logger.error(`Paystack webhook processing error for ${data?.reference}: ${err.message}`);
  }
};
