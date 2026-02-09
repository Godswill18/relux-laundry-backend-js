const mongoose = require('mongoose');

const PayrollPeriodSchema = new mongoose.Schema(
  {
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: ['draft', 'finalized', 'paid'], default: 'draft' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PayrollPeriod', PayrollPeriodSchema);
