const mongoose = require('mongoose');

const PayslipSchema = new mongoose.Schema(
  {
    entryId: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollEntry', required: true, unique: true },
    data: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payslip', PayslipSchema);
