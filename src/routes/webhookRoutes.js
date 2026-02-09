const express = require('express');
const router = express.Router();
const { handleClerkWebhook } = require('../controllers/webhookController.js');

// POST /api/webhooks/clerk
// Raw body is required for Svix signature verification.
// This route is mounted before express.json() in app.js.
router.post('/clerk', handleClerkWebhook);

module.exports = router;
