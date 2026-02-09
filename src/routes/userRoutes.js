const express = require('express');
const router = express.Router();
const {
  getUsers,
  getUser,
  createStaff,
  updateUser,
  deactivateUser,
  deleteUser,
} = require('../controllers/userController.js');

const { protect, authorize } = require('../middleware/auth.js');

// All routes require authentication and admin/manager role
router.use(protect);
router.use(authorize('admin', 'manager'));

router.route('/')
.get(getUsers);

router.route('/staff')
  .post(createStaff);

router.route('/:id')
  .get(getUser)
  .put(updateUser)
  .delete(deleteUser);

router.put('/:id/deactivate', deactivateUser);

module.exports = router;
