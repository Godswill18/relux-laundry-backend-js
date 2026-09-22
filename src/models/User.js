const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const AddressSchema = new mongoose.Schema({
  street: { type: String, required: true },
  landmark: String,
  city: { type: String, required: true },
  state: { type: String, required: true },
  isDefault: { type: Boolean, default: false },
});

const UserSchema = new mongoose.Schema(
  {
    clerkId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    authProvider: {
      type: String,
      enum: ['local', 'clerk'],
      default: 'local',
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      unique: true,
    },
    phone: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    password: {
      type: String,
      required: [
        function () {
          return this.authProvider !== 'clerk';
        },
        'Password is required',
      ],
      minlength: 6,
      select: false,
    },
    role: {
      type: String,
      // 'receptionist' is referenced by rolePermissions, four authorize() lists,
      // Order.createdByRole, getOrders' admin-role check and both frontends, but
      // was missing here — so the role could never actually be created and every
      // receptionist code path was dead. Widening the enum is backward compatible.
      enum: ['customer', 'staff', 'admin', 'manager', 'delivery', 'receptionist', 'developer'],
      default: 'customer',
    },
    staffRole: {
      type: String,
      // Was written as the sparse literal [, 'washer', 'delivery', null], whose
      // first element is `undefined`. Spelled out explicitly and widened to cover
      // the values the seeder and admin UI already use.
      enum: ['washer', 'ironer', 'delivery', 'receptionist', null],
    },
    address: String,
    city: String,
    gender: {
      type: String,
      enum: ['male', 'female', 'prefer_not_to_say', null],
    },
    dateOfBirth: String,
    addresses: [AddressSchema],
    preferredPickupTime: String,
    isActive: {
      type: Boolean,
      default: true,
    },
    // Account-status trail. isActive above stays the single access switch —
    // login, protect() and socketAuth all enforce it — these only record who
    // changed it, when and why. All optional: existing documents need no
    // migration, and a missing value simply means "never deactivated".
    deactivatedAt:      { type: Date },
    deactivatedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deactivationReason: { type: String, trim: true, maxlength: 500 },
    reactivatedAt:      { type: Date },
    reactivatedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      unique: true,
      sparse: true,
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
    },
    referralCode: {
      type: String,
      unique: true,
      sparse: true,
    },
    referralChanges: {
      type: Number,
      default: 0,
    },
    // Staff-specific fields
    hireDate: String,
    bankName: String,
    bankAccountNumber: String,
    bankAccountName: String,
    emergencyContactName: String,
    emergencyContactPhone: String,
    guarantorName: String,
    guarantorPhone: String,
    otp: String,
    otpExpires: Date,
    jwtVersion: { type: Number, default: 1 },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    return next();
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate JWT token
UserSchema.methods.generateAuthToken = function () {
  return jwt.sign(
    { id: this._id, role: this.role, jwtVersion: this.jwtVersion },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRE || '7d',
    }
  );
};

module.exports = mongoose.model('User', UserSchema);
