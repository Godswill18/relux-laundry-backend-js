// ─── Service-level SLA — one processing deadline per order ─────────────────
//
// The promised turnaround comes from the order's SERVICE LEVEL (Standard,
// Express, Premium Express …), never from the laundry service on a garment
// (Wash & Iron, Dry Cleaning …) and never from the progress status (washing,
// ironing …). Progress statuses only describe where the order is.
//
// The database is the only clock. When an order is confirmed the server stamps
// `confirmedAt` and snapshots the level's configured hours onto the order:
//   slaServiceLevelId / slaServiceLevelName / slaHours
//   slaDueAt = confirmedAt + slaHours          (the estimated completion time)
// From then on nothing moves that deadline except an explicit, audited change
// of service level (see requestServiceLevelChange). Editing the level's hours
// only affects orders confirmed afterwards.
//
// The clock stops when the whole order is ready (`readyAt`). Partially ready
// orders keep running; collection is customer time and never counts.
//
// Clients never derive a deadline: they receive `buildSlaView()` (timestamps +
// `serverTime`) and only animate the countdown against a server-clock offset.

const mongoose = require('mongoose');

const HOUR = 60 * 60 * 1000;

// Developer is the "Superadmin" of this app (see AdminLayout). Other roles may
// set the hours only when the developer grants them SLA_PERMISSION in
// Roles & Permissions.
const SLA_CONFIG_ROLES = ['developer'];
const SLA_PERMISSION = 'MANAGE_SERVICE_SLA';

// Due soon = this fraction (or less) of the order's processing window remains.
const SLA_DUE_SOON_FRACTION = 0.25;

const SLA_MIN_HOURS = 0.25;
const SLA_MAX_HOURS = 24 * 30;

// Orders in these states have finished processing (mirrors orderFulfilment).
const { READY_STATUSES } = require('./orderStatus.js');
// A move from one of these into an active status is a (re)confirmation.
const NOT_STARTED_STATUSES = ['draft', 'pending', 'cancelled'];

const ms = (d) => (d ? new Date(d).getTime() : null);
const sameId = (a, b) => String(a || '') === String(b || '');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Developer always; anyone else only through the live role permission. */
async function canConfigureSla(role) {
  if (SLA_CONFIG_ROLES.includes(role)) return true;
  const { getRolePermissionsFromDB } = require('./rolePermissions.js');
  return (await getRolePermissionsFromDB(role)).includes(SLA_PERMISSION);
}

function validHours(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= SLA_MIN_HOURS && n <= SLA_MAX_HOURS ? n : null;
}

/**
 * The order's service level, resolved the same way order creation prices it:
 * by serviceLevelId, else by name (legacy orders carry only the name).
 */
async function resolveServiceLevel(order) {
  const ServiceLevelConfig = require('../models/ServiceLevelConfig.js');
  if (order.serviceLevelId && mongoose.isValidObjectId(order.serviceLevelId)) {
    const byId = await ServiceLevelConfig.findById(order.serviceLevelId).lean();
    if (byId) return byId;
  }
  const name = order.serviceLevelName || order.serviceLevel;
  if (!name) return null;
  return ServiceLevelConfig.findOne({ name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') } }).lean();
}

/** Copy the level's current hours onto the order, anchored at confirmedAt. */
function snapshot(order, level) {
  const hours = validHours(level?.slaHours);
  order.slaServiceLevelId = level?._id;
  order.slaServiceLevelName = level?.name;
  if (hours) {
    order.slaHours = hours;
    order.slaDueAt = new Date(ms(order.confirmedAt) + hours * HOUR);
  } else {
    // Level has no processing time configured: no promise is made.
    order.slaHours = undefined;
    order.slaDueAt = undefined;
  }
}

function isOrderReady(order) {
  if (order.status === 'cancelled') return false;
  if (order.itemTracking) {
    const items = order.items || [];
    return items.length > 0 && items.every((i) => (i.readyQuantity || 0) >= (i.quantity || 0));
  }
  return READY_STATUSES.includes(order.status);
}

/**
 * Pre-save: keep the SLA fields in step with the order. Runs on every save but
 * only acts on a real start, an authorised service-level change, or a ready flip.
 * Returns notable changes for the post-save hook to audit.
 */
async function applySla(order, { now = new Date() } = {}) {
  const changes = [];
  const prevStatus = order.$locals?.prevStatus;
  const startsNow = !order.confirmedAt
    && !NOT_STARTED_STATUSES.includes(order.status)
    && (order.isNew || NOT_STARTED_STATUSES.includes(prevStatus));
  // An order already past confirmation with no stamp is a legacy order: its
  // start is unknown and is never invented.
  if (!order.confirmedAt && !startsNow) return changes;

  if (startsNow) {
    order.confirmedAt = now;
    snapshot(order, await resolveServiceLevel(order));
  } else {
    const approved = order.$locals?.slaLevelChange;
    if (approved && !sameId(order.serviceLevelId, order.slaServiceLevelId)) {
      const before = { serviceLevelId: order.slaServiceLevelId, serviceLevelName: order.slaServiceLevelName, hours: order.slaHours, dueAt: order.slaDueAt };
      snapshot(order, await resolveServiceLevel(order));
      changes.push({
        action: 'ORDER_SLA_SERVICE_LEVEL_CHANGED',
        before,
        after: { serviceLevelId: order.slaServiceLevelId, serviceLevelName: order.slaServiceLevelName, hours: order.slaHours, dueAt: order.slaDueAt },
        reason: approved.reason,
        actorId: approved.actorId,
      });
    }
    // Any other change of level after confirmation keeps the original promise;
    // the controller refuses it unless it is an explicit, reasoned change.
  }

  recomputeSlaState(order, now);
  return changes;
}

/** Stamp/clear readyAt and the fields the list filters and alerts use. */
function recomputeSlaState(order, now = new Date()) {
  if (!order.confirmedAt) return;
  const ready = isOrderReady(order);
  if (ready && !order.readyAt) order.readyAt = now;
  else if (!ready && order.readyAt) order.readyAt = undefined;

  const running = !!order.slaDueAt && !ready && order.status !== 'cancelled';
  order.slaActiveDueAt = running ? order.slaDueAt : undefined;
  order.slaDueSoonAt = running
    ? new Date(ms(order.slaDueAt) - order.slaHours * HOUR * SLA_DUE_SOON_FRACTION)
    : undefined;
}

/**
 * The one SLA payload every client renders — identical for staff, admin and
 * customer. `serverTime` lets a client correct for a wrong device clock.
 * Works on documents and lean objects.
 */
function buildSlaView(order, at = new Date()) {
  const atMs = at.getTime();
  const base = { serverTime: at.toISOString(), dueSoonFraction: SLA_DUE_SOON_FRACTION };
  const o = order?.toObject ? order.toObject() : order;
  if (!o) return { ...base, state: 'unavailable', available: false };

  const levelName = o.slaServiceLevelName || o.serviceLevelName || o.serviceLevel || null;
  if (o.status === 'cancelled') return { ...base, state: 'stopped', available: false, serviceLevel: levelName, confirmedAt: o.confirmedAt || null };
  if (!o.confirmedAt) {
    // 'not_started' = begins on confirmation; 'unavailable' = legacy order
    const notYet = NOT_STARTED_STATUSES.includes(o.status);
    return { ...base, state: notYet ? 'not_started' : 'unavailable', available: false, serviceLevel: levelName };
  }
  if (!o.slaDueAt) {
    return { ...base, state: 'unavailable', available: false, serviceLevel: levelName, confirmedAt: o.confirmedAt };
  }

  const due = ms(o.slaDueAt);
  let state;
  if (o.readyAt) state = ms(o.readyAt) <= due ? 'on_time' : 'completed_late';
  else if (atMs > due) state = 'overdue';
  else if (atMs >= due - o.slaHours * HOUR * SLA_DUE_SOON_FRACTION) state = 'due_soon';
  else state = 'running';

  return {
    ...base,
    available: true,
    state,
    serviceLevel: levelName,
    serviceLevelId: o.slaServiceLevelId || null,
    hours: o.slaHours,
    startedAt: o.confirmedAt,
    confirmedAt: o.confirmedAt,
    dueAt: o.slaDueAt,
    estimatedCompletionAt: o.slaDueAt,
    readyAt: o.readyAt || null,
    isOverdue: state === 'overdue',
  };
}

/** Mongo filter for list screens: 'overdue' | 'due_soon' | 'running'. */
function slaFilter(kind, at = new Date()) {
  if (kind === 'overdue') return { slaActiveDueAt: { $lt: at } };
  if (kind === 'due_soon') return { slaDueSoonAt: { $lte: at }, slaActiveDueAt: { $gte: at } };
  if (kind === 'running') return { slaDueSoonAt: { $gt: at } };
  return null;
}

module.exports = {
  SLA_CONFIG_ROLES,
  SLA_PERMISSION,
  SLA_DUE_SOON_FRACTION,
  SLA_MIN_HOURS,
  SLA_MAX_HOURS,
  READY_STATUSES,
  NOT_STARTED_STATUSES,
  canConfigureSla,
  validHours,
  resolveServiceLevel,
  applySla,
  recomputeSlaState,
  buildSlaView,
  slaFilter,
};
