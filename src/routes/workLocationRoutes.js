const express = require('express');
const router = express.Router();
const { getWorkLocation, saveWorkLocation, parseMapsLink } = require('../controllers/workLocationController.js');
const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);

router.get('/', getWorkLocation);
router.put('/', authorize('admin', 'manager'), saveWorkLocation);
router.post('/parse-link', authorize('admin', 'manager'), parseMapsLink);

module.exports = router;
