const express = require('express');
const router = express.Router();
const {
  getThreads,
  getThread,
  createThread,
  closeThread,
  getMessages,
  sendMessage,
} = require('../controllers/chatController.js');

const { dualProtect } = require('../middleware/auth.js');

router.use(dualProtect);

router.route('/').get(getThreads).post(createThread);

router.route('/:id').get(getThread);

router.put('/:id/close', closeThread);

router.route('/:id/messages').get(getMessages).post(sendMessage);

module.exports = router;
