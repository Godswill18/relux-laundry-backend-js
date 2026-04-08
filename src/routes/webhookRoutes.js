const express = require('express');
const router = express.Router();
const { handleClerkWebhook, handlePaystackWebhook } = require('../controllers/webhookController.js');

// POST /api/webhooks/clerk
// Raw body required for Svix signature verification.
router.post('/clerk', handleClerkWebhook);

// POST /api/webhooks/paystack
// Raw body required for HMAC-SHA512 signature verification.
// This route is already mounted under express.raw() in app.js.
router.post('/paystack', handlePaystackWebhook);

module.exports = router;
