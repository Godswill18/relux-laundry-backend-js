const mongoose = require('mongoose');

// ── Addon Model ───────────────────────────────────────────────────────────────
// A selectable extra (starch, stain removal, fragrance, express handling…).
//
// scope decides WHERE the add-on is charged:
//   'order' — the original behaviour, one charge for the whole order:
//             type='fixed'      → value is a flat ₦ amount added to the order
//             type='percentage' → value is a % of the order's item subtotal
//   'item'  — charged per garment on one order line, for the number of garments
//             the customer chose (e.g. starch on 2 of 5 shirts):
//             type='fixed'      → value is ₦ per garment, see garmentPricing below
//             type='percentage' → value is a % of that line's unit price, per garment
//             (already varies by garment, since unit price does — garmentPricing
//             overrides don't apply to a percentage add-on)
//
// Documents created before `scope` existed have no such field and are read as
// 'order' everywhere (see Addon.scopeOf()), so their pricing never changes.
//
// garmentPricing (item-scope, fixed-type only): optional overrides of `value`
// for specific garments, e.g. "Stain Removal is ₦500 on a Shirt but ₦1,000 on
// a Bedsheet" — a laundry add-on rarely costs the same on every garment. Each
// entry is keyed by the garment name (as it appears on ServiceCategory.name;
// a garment like "Shirt" spans several categories, one per service, so the
// override is matched by name, not by one categoryId) plus an optional
// serviceId for a narrower override that only applies with one service.
// Resolution (see Addon.resolveUnitPrice): an entry matching both garment AND
// service wins; failing that, an entry matching the garment with no service
// set; failing that, the flat `value`. Never more than a few rows per add-on,
// so this is embedded rather than a separate collection.
// ─────────────────────────────────────────────────────────────────────────────

const AddonGarmentPriceSchema = new mongoose.Schema({
  garmentName: { type: String, required: true, trim: true },
  // Narrows the override to one service (e.g. Shirt + Wash & Iron only).
  // Omitted = applies to this garment under any service.
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
  price: { type: Number, required: true, min: 0 },
}, { _id: false });

const AddonSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // 'fixed' = ₦ flat fee  |  'percentage' = % (see scope above for the base)
    type: {
      type: String,
      enum: ['fixed', 'percentage'],
      required: true,
    },
    // Monetary value (₦) for 'fixed', or percent for 'percentage' (e.g. 10 = 10%)
    value: {
      type: Number,
      required: true,
      min: 0,
    },
    scope: {
      type: String,
      enum: ['order', 'item'],
      default: 'order',
    },
    // Item-scope only: the services this add-on may be combined with (e.g.
    // starch only with Wash & Iron). Empty means any service.
    eligibleServiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],
    // Item-scope, fixed-type only: per-garment price overrides. See note above.
    garmentPricing: { type: [AddonGarmentPriceSchema], default: [] },
    description: {
      type: String,
      default: '',
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Missing scope (pre-existing documents, lean reads) means 'order'.
AddonSchema.statics.scopeOf = (addon) => (addon && addon.scope === 'item' ? 'item' : 'order');

const normName = (s) => String(s || '').trim().toLowerCase();

// The ₦-per-garment (or %-of-unit-price) this add-on charges for one specific
// order line. `garmentName` and `serviceId` identify the line (its garment
// and the service it was ordered under); `lineUnitPrice` is that line's
// resolved service price, needed for a percentage add-on.
//
// Percentage add-ons are unaffected by garmentPricing — they already scale
// with the garment via lineUnitPrice. For a fixed add-on: a garment+service
// match wins, then a garment-only match, then the flat `value`.
AddonSchema.statics.resolveUnitPrice = (addon, { garmentName, serviceId, lineUnitPrice } = {}) => {
  if (!addon) return 0;
  if (addon.type === 'percentage') {
    return Math.round((lineUnitPrice || 0) * (addon.value || 0) / 100);
  }
  const overrides = addon.garmentPricing || [];
  const name = normName(garmentName);
  const svc = serviceId ? String(serviceId) : null;
  if (name && overrides.length) {
    const exact = overrides.find((o) => normName(o.garmentName) === name && o.serviceId && String(o.serviceId) === svc);
    if (exact) return Math.round(exact.price);
    const byGarment = overrides.find((o) => normName(o.garmentName) === name && !o.serviceId);
    if (byGarment) return Math.round(byGarment.price);
  }
  return Math.round(addon.value || 0);
};

module.exports = mongoose.model('Addon', AddonSchema);
