const express = require('express');
const router = express.Router();
const {
  getRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
} = require('../controllers/roleController.js');

const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);
router.use(authorize('admin'));

router.route('/').get(getRoles).post(createRole);

router.route('/:id').get(getRole).put(updateRole).delete(deleteRole);

module.exports = router;
