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
      enum: ['customer', 'staff', 'admin', 'manager'],
      default: 'customer',
    },
    staffRole: {
      type: String,
      enum: ['receptionist', 'washer', 'delivery', null],
    },
    addresses: [AddressSchema],
    preferredPickupTime: String,
    isActive: {
      type: Boolean,
      default: true,
    },
    isPhoneVerified: {
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
    otp: String,
    otpExpires: Date,
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
    { id: this._id, role: this.role },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRE || '7d',
    }
  );
};

module.exports = mongoose.model('User', UserSchema);
