const express = require('express');
const router = express.Router();
const {
  getRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  getRoleUsers,
  assignUserToRole,
} = require('../controllers/roleController.js');

const { protect, authorize } = require('../middleware/auth.js');

router.use(protect);

router.route('/')
  .get(authorize('admin', 'manager'), getRoles)
  .post(authorize('admin'), createRole);

router.route('/:id')
  .get(authorize('admin', 'manager'), getRole)
  .put(authorize('admin'), updateRole)
  .delete(authorize('admin'), deleteRole);

router.get('/:id/users', authorize('admin', 'manager'), getRoleUsers);
router.patch('/:id/assign', authorize('admin'), assignUserToRole);

module.exports = router;
