// ─── Order line pricing — the one place an order line gets its price ─────────
//
// Every line is priced here from the database. Nothing the client sends about
// money (unitPrice, total, add-on amounts, counters) is copied onto the order:
// each line is rebuilt field by field from a whitelist.
//
// The price list is Service → ServiceCategory: a ServiceCategory is one garment
// under one service ("Shirt" under "Wash & Iron", ₦500). So a line names the
// category, and that fixes the garment, the service and the unit price at once.
// The same garment can appear on several lines with different services.
//
// Line add-ons (Addon.scope === 'item') are charged per garment, for as many of
// the line's garments as the customer chose — never more than the line holds.
// A fixed-type line add-on may price differently by garment (and optionally by
// service) — see Addon.garmentPricing / Addon.resolveUnitPrice. "Stain Removal"
// can be ₦500 on a Shirt and ₦1,000 on a Bedsheet without being two add-ons.
//
// The old care-type multipliers (wash-iron ×1.5, iron-only ×0.6…) are gone: the
// service is now determined by the category itself, and trusting a care type
// from the request let a customer post 'iron-only' against a wash-and-iron
// price for 40% off. No current screen sent that combination.

const mongoose = require('mongoose');
const ServiceCategory = require('../models/ServiceCategory.js');
const Service = require('../models/Service.js');
const Addon = require('../models/Addon.js');
const AppError = require('./appError.js');
const ERROR_CODES = require('./errorCodes.js');

const MAX_LINES = 100;
const MAX_LINE_QUANTITY = 1000;

const invalid = (message) => new AppError(message, 400, ERROR_CODES.VALIDATION_ERROR);
const idOf = (v) => (v && typeof v === 'object' && v._id ? v._id : v);
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
// Same catalogue entry — or both manual lines with the same name.
const sameLine = (prior, line) => String(prior.categoryId || '') === String(line.categoryId || '')
  && (line.priceSource !== 'manual' || prior.itemType === line.itemType);

// A positive whole number, or a 400 that says which line is wrong.
function parseQuantity(value, label, max = MAX_LINE_QUANTITY) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw invalid(`${label}: quantity must be a whole number of at least 1`);
  }
  if (n > max) throw invalid(`${label}: quantity cannot be more than ${max}`);
  return n;
}

const trimmed = (v, max) => {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
};

// ₦ per garment for a line add-on, honouring any garment/service-specific
// override configured on the add-on (see Addon.resolveUnitPrice). A generic
// "Stain Removal = ₦500" add-on can be priced differently on a Bedsheet than
// on a Shirt without becoming a different add-on.
function addonUnitPrice(addon, { garmentName, serviceId, lineUnitPrice } = {}) {
  return Addon.resolveUnitPrice(addon, { garmentName, serviceId, lineUnitPrice });
}

/**
 * Price and validate the lines of an order.
 *
 * @param {Array}   rawItems        lines as sent by the client
 * @param {Object}  opts
 * @param {boolean} opts.allowManual   staff may add a line that is not in the
 *                                     price list, at a price they enter
 * @param {Array}   [opts.existingItems] the order's current lines, when editing.
 *                                     A line sent back with its _id keeps its
 *                                     agreed prices and its garment counters.
 * @param {boolean} [opts.tracked]     the order records garments per line —
 *                                     new lines start at 0 ready / 0 collected
 * @returns {{ items, subtotal, itemAddonsFee, totalGarments }}
 */
async function priceOrderItems(rawItems, { allowManual = false, existingItems = null, tracked = false } = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw invalid('Add at least one item to the order');
  }
  if (rawItems.length > MAX_LINES) {
    throw invalid(`An order can have at most ${MAX_LINES} lines`);
  }

  // ── Load everything the request refers to, once ──────────────────────────
  const categoryIds = new Set();
  const addonIds = new Set();
  for (const raw of rawItems) {
    const cid = idOf(raw?.categoryId || raw?.serviceCategoryId);
    if (cid && mongoose.isValidObjectId(cid)) categoryIds.add(String(cid));
    for (const a of Array.isArray(raw?.addons) ? raw.addons : []) {
      const aid = idOf(a?.addonId);
      if (aid && mongoose.isValidObjectId(aid)) addonIds.add(String(aid));
    }
  }

  const categories = categoryIds.size
    ? await ServiceCategory.find({ _id: { $in: [...categoryIds] } }).lean()
    : [];
  const categoryMap = new Map(categories.map((c) => [String(c._id), c]));
  const serviceIds = [...new Set(categories.map((c) => String(c.serviceId)).filter(Boolean))];
  const services = serviceIds.length ? await Service.find({ _id: { $in: serviceIds } }).lean() : [];
  const serviceMap = new Map(services.map((s) => [String(s._id), s]));
  const addons = addonIds.size ? await Addon.find({ _id: { $in: [...addonIds] } }).lean() : [];
  const addonMap = new Map(addons.map((a) => [String(a._id), a]));

  const existing = Array.isArray(existingItems) ? existingItems : [];
  const existingById = new Map(existing.map((it) => [String(it._id), it]));
  const keptIds = new Set();

  const items = [];
  let subtotal = 0;
  let itemAddonsFee = 0;
  let totalGarments = 0;

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i] || {};
    const position = `Item ${i + 1}`;

    // Only an _id that belongs to a current line is honoured. Anything else is
    // a new line and gets a fresh id.
    const prior = raw._id ? existingById.get(String(raw._id)) : null;
    if (prior) {
      if (keptIds.has(String(prior._id))) throw invalid(`${position}: this line appears twice`);
      keptIds.add(String(prior._id));
    }

    const categoryId = idOf(raw.categoryId || raw.serviceCategoryId);
    let line;

    if (categoryId) {
      if (!mongoose.isValidObjectId(categoryId)) throw invalid(`${position}: unknown item`);
      const category = categoryMap.get(String(categoryId));
      const service = category ? serviceMap.get(String(category.serviceId)) : null;
      // A line kept from before an edit keeps the price agreed when it was
      // ordered, even if the price list (or the item itself) changed since.
      const keepsAgreedPrice = !!prior && sameId(prior.categoryId, categoryId);

      if (!keepsAgreedPrice) {
        if (!category || category.active === false) {
          throw invalid(`${position}: ${category?.name || 'this item'} is no longer available`);
        }
        if (!service || service.active === false) {
          throw invalid(`${position}: ${category.name} is not currently offered${service ? ` for ${service.name}` : ''}`);
        }
      }

      const garment = keepsAgreedPrice ? (prior.categoryName || prior.itemType) : category.name;
      const serviceName = keepsAgreedPrice ? (prior.serviceName || service?.name) : service.name;
      line = {
        itemType: garment,
        categoryName: garment,
        categoryId: String(categoryId),
        serviceId: keepsAgreedPrice ? (prior.serviceId || category?.serviceId) : category.serviceId,
        serviceName,
        serviceType: serviceName,
        unitPrice: keepsAgreedPrice ? (prior.unitPrice || 0) : Math.round(category.basePrice || 0),
        priceSource: 'catalogue',
      };
    } else {
      // Not in the price list. Only staff at the counter may do this, and the
      // line is marked 'manual' so it is visibly different on the order.
      if (!allowManual) throw invalid(`${position}: choose an item from the price list`);
      const name = trimmed(raw.itemType, 120);
      if (!name) throw invalid(`${position}: item name is required`);
      const price = Number(raw.unitPrice);
      if (!Number.isFinite(price) || price < 0) throw invalid(`${position} (${name}): enter a price of 0 or more`);
      const serviceName = trimmed(raw.serviceName, 120) || trimmed(raw.serviceType, 120);
      line = {
        itemType: name,
        serviceName,
        serviceType: trimmed(raw.serviceType, 120) || serviceName,
        unitPrice: Math.round(price),
        priceSource: 'manual',
      };
    }

    const label = `${position} (${line.itemType}${line.serviceName ? ` — ${line.serviceName}` : ''})`;
    const quantity = parseQuantity(raw.quantity, label);

    // ── Garment counters carried over from the existing line ────────────────
    if (prior) {
      const ready = prior.readyQuantity || 0;
      const collected = prior.collectedQuantity || 0;
      if ((ready > 0 || collected > 0) && !sameLine(prior, line)) {
        throw invalid(`${label}: garments on this line are already marked ready or collected, so its item or service can't be changed`);
      }
      if (quantity < ready) {
        throw invalid(`${label}: ${ready} garment(s) on this line are already marked ready, so the quantity can't go below ${ready}`);
      }
    }

    // ── Line add-ons ─────────────────────────────────────────────────────────
    const lineAddons = [];
    const seen = new Set();
    for (const rawAddon of Array.isArray(raw.addons) ? raw.addons : []) {
      const addonId = idOf(rawAddon?.addonId);
      if (!addonId || !mongoose.isValidObjectId(addonId)) throw invalid(`${label}: unknown add-on`);
      if (seen.has(String(addonId))) throw invalid(`${label}: the same add-on is listed twice`);
      seen.add(String(addonId));

      const addon = addonMap.get(String(addonId));
      // Kept unchanged from before an edit → keeps its agreed price.
      const priorAddon = prior && sameLine(prior, line)
        ? (prior.addons || []).find((a) => sameId(a.addonId, addonId))
        : null;
      const addonName = addon?.name || priorAddon?.name || 'Add-on';

      if (!priorAddon) {
        if (!addon) throw invalid(`${label}: add-on not found`);
        if (Addon.scopeOf(addon) !== 'item') {
          throw invalid(`${label}: ${addon.name} applies to the whole order, not to individual garments`);
        }
        if (addon.active === false) throw invalid(`${label}: ${addon.name} is no longer available`);
        const eligible = addon.eligibleServiceIds || [];
        if (eligible.length && !eligible.some((s) => sameId(s, line.serviceId))) {
          throw invalid(`${label}: ${addon.name} isn't available with ${line.serviceName || 'this service'}`);
        }
      }

      const addonQty = parseQuantity(rawAddon.quantity, `${label} — ${addonName}`);
      if (addonQty > quantity) {
        throw invalid(`${label}: ${addonName} can apply to at most ${quantity} garment(s) on this line — you entered ${addonQty}`);
      }

      const unitPrice = priorAddon
        ? (priorAddon.unitPrice || 0)
        : addonUnitPrice(addon, { garmentName: line.categoryName || line.itemType, serviceId: line.serviceId, lineUnitPrice: line.unitPrice });
      lineAddons.push({
        addonId: priorAddon ? priorAddon.addonId : addon._id,
        name: priorAddon ? priorAddon.name : addon.name,
        type: priorAddon ? priorAddon.type : addon.type,
        value: priorAddon ? priorAddon.value : addon.value,
        quantity: addonQty,
        unitPrice,
        total: unitPrice * addonQty,
      });
    }

    const serviceTotal = line.unitPrice * quantity;
    const addonsTotal = lineAddons.reduce((sum, a) => sum + a.total, 0);

    const item = {
      ...line,
      quantity,
      total: serviceTotal,
      addons: lineAddons,
      addonsTotal,
      lineTotal: serviceTotal + addonsTotal,
      notes: trimmed(raw.notes, 500),
      description: trimmed(raw.description, 500),
      condition: trimmed(raw.condition, 200),
      careType: trimmed(raw.careType, 60),
    };
    if (prior) {
      item._id = prior._id;
      if (prior.readyQuantity != null) item.readyQuantity = prior.readyQuantity;
      if (prior.collectedQuantity != null) item.collectedQuantity = prior.collectedQuantity;
    }
    if (tracked) {
      item.readyQuantity = item.readyQuantity || 0;
      item.collectedQuantity = item.collectedQuantity || 0;
    }

    items.push(item);
    subtotal += serviceTotal;
    itemAddonsFee += addonsTotal;
    totalGarments += quantity;
  }

  // Lines dropped by an edit must not take recorded garments with them.
  for (const prior of existing) {
    if (keptIds.has(String(prior._id))) continue;
    if ((prior.readyQuantity || 0) > 0 || (prior.collectedQuantity || 0) > 0) {
      throw invalid(`${prior.itemType}${prior.serviceName ? ` (${prior.serviceName})` : ''}: garments on this line are already marked ready or collected, so it can't be removed`);
    }
  }

  return { items, subtotal, itemAddonsFee, totalGarments };
}

/**
 * Resolve order-level add-ons (the original kind). Unchanged behaviour: fixed ₦
 * per order, or a % of the item subtotal. An item-level add-on sent here is
 * refused rather than silently dropped or charged the wrong way.
 */
async function priceOrderAddons(rawAddons, baseSubtotal) {
  const resolved = [];
  let fee = 0;
  if (!Array.isArray(rawAddons) || rawAddons.length === 0) return { addons: resolved, fee };

  const seen = new Set();
  for (const a of rawAddons) {
    const id = idOf(a?.addonId);
    if (!id || !mongoose.isValidObjectId(id) || seen.has(String(id))) continue;
    seen.add(String(id));
    const addonDoc = await Addon.findById(id).lean();
    if (!addonDoc || !addonDoc.active) continue;
    if (Addon.scopeOf(addonDoc) === 'item') {
      throw invalid(`${addonDoc.name} is charged per garment — add it to the item it applies to`);
    }
    const calculatedAmount = addonDoc.type === 'fixed'
      ? addonDoc.value
      : Math.round(baseSubtotal * addonDoc.value / 100);
    fee += calculatedAmount;
    resolved.push({
      addonId: addonDoc._id,
      name: addonDoc.name,
      type: addonDoc.type,
      value: addonDoc.value,
      calculatedAmount,
    });
  }
  return { addons: resolved, fee };
}

module.exports = {
  priceOrderItems,
  priceOrderAddons,
  addonUnitPrice,
  parseQuantity,
  MAX_LINE_QUANTITY,
};
