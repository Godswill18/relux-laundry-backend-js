const mongoose = require('mongoose');

const PayrollPeriodSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    frequency: {
      type: String,
      enum: ['weekly', 'biweekly', 'monthly', 'custom'],
      default: 'monthly',
    },
    status: {
      type: String,
      enum: ['draft', 'approved', 'finalized', 'paid'],
      default: 'draft',
    },
    staffIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    totalAmount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

PayrollPeriodSchema.index({ status: 1 });
PayrollPeriodSchema.index({ startDate: -1 });

module.exports = mongoose.model('PayrollPeriod', PayrollPeriodSchema);
