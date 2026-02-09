const mongoose = require('mongoose');

const ServiceCategorySchema = new mongoose.Schema(
  {
    serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
    name: { type: String, required: true, trim: true },
    basePrice: { type: Number, required: true },
    unit: { type: String, default: 'item' },
    icon: { type: String },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ServiceCategorySchema.index({ serviceId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('ServiceCategory', ServiceCategorySchema);
