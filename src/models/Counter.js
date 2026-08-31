const mongoose = require('mongoose');

// Atomic sequence allocator.
//
// Used for order numbers, which were previously derived from
// countDocuments() — a read-then-write that hands the same number to two
// concurrent creations (E11000 on the second) and reissues retired numbers
// after any hard delete. A counter document is incremented atomically instead,
// so each caller gets a number nobody else can receive.
//
// _id is the scope key, e.g. 'order:202608'.
const CounterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Counter', CounterSchema);
