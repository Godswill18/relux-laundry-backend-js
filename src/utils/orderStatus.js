// ─── Order status — the ONE canonical definition ────────────────────────────
//
// Six high-level statuses, persisted lowercase (the project's existing
// convention): pending, confirmed, in_progress, ready, completed, cancelled.
//
// Everything else that used to masquerade as a status is DETAIL, not status:
//   washing / ironing        → in_progress (activity, if ever needed, is separate)
//   out-for-delivery         → ready       (Order.deliveryStatus + dispatchedAt)
//   picked-up                → confirmed   (Order.actualPickupDate / pickupStaffId)
//   delivered                → completed   (Order.deliveryStatus + actualDeliveryDate)
//   partially ready/collected→ never a status: see Order.fulfilmentStatus + counters
// Payment status is a different field and is never mapped into these.

const ORDER_STATUSES = ['pending', 'confirmed', 'in_progress', 'ready', 'completed', 'cancelled'];

const ORDER_STATUS_LABELS = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  in_progress: 'In Progress',
  ready: 'Ready',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

// Explicit, reviewed mapping. Keys are compared after normalising case and
// separators (see key()). Anything not listed is NOT guessed — it is rejected
// on input and reported by the migration.
const LEGACY_STATUS_MAP = {
  washing: 'in_progress',
  ironing: 'in_progress',
  out_for_delivery: 'ready',
  picked_up: 'confirmed',
  delivered: 'completed',
  // Labels / spellings older clients may still send
  inprogress: 'in_progress',
};

const key = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');

/**
 * → { status, legacy } where status is canonical or null when the value is
 * unknown. `legacy` is the original value when a retired status was mapped.
 */
function normalizeOrderStatus(value) {
  const k = key(value);
  if (ORDER_STATUSES.includes(k)) return { status: k, legacy: null };
  if (LEGACY_STATUS_MAP[k]) return { status: LEGACY_STATUS_MAP[k], legacy: String(value) };
  return { status: null, legacy: null };
}

const isOrderStatus = (v) => ORDER_STATUSES.includes(v);

// Terminal: no further processing. Reopening needs a supervisor.
const TERMINAL_STATUSES = ['completed', 'cancelled'];
// Open = still being worked on or awaiting the customer.
const OPEN_STATUSES = ['pending', 'confirmed', 'in_progress', 'ready'];
// Every garment is finished (the SLA clock stops here).
const READY_STATUSES = ['ready', 'completed'];
// Every garment is finished and handed over.
const COLLECTED_STATUSES = ['completed'];
// Before every garment is ready.
const PRE_READY_STATUSES = ['pending', 'confirmed', 'in_progress'];
// Status values that may still sit in old rows (migration source set).
const LEGACY_DB_VALUES = ['washing', 'ironing', 'out-for-delivery', 'picked-up', 'delivered'];

// ── List filters (transition-safe) ──────────────────────────────────────────
// Until every stored row is migrated, a canonical filter must also match the
// retired values that mean the same thing, or those orders vanish from lists.
// Only values this application has actually written are listed.
const STORED_VALUES = {
  pending: ['pending'],
  confirmed: ['confirmed', 'picked-up'],
  in_progress: ['in_progress', 'washing', 'ironing'],
  ready: ['ready', 'out-for-delivery'],
  completed: ['completed', 'delivered'],
  cancelled: ['cancelled'],
};
// Stored values that mean "finished" (for "active / not finished" filters).
const TERMINAL_STORED_VALUES = [...STORED_VALUES.completed, ...STORED_VALUES.cancelled];
const ALL_FILTER_VALUES = ['', 'all', 'any', '*'];

/**
 * Mongo condition for a status filter from a request.
 *   'all' / empty      → null  (NO status condition at all — never an $in of
 *                               known statuses, which would hide unknown rows)
 *   canonical / legacy → { $in: [canonical + equivalent stored values] }
 *   anything else      → undefined (caller rejects with 400)
 */
function statusFilterCondition(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (ALL_FILTER_VALUES.includes(raw)) return null;
  const { status } = normalizeOrderStatus(raw);
  if (!status) return undefined;
  return { $in: STORED_VALUES[status] };
}

// "Not finished" — excludes completed/delivered/cancelled, keeps every other
// value (including any unexpected one) so nothing open is ever hidden.
const notTerminalCondition = () => ({ $nin: TERMINAL_STORED_VALUES });

/**
 * Per-status counts from `{_id: storedValue, n}` rows: legacy values folded
 * into their canonical bucket; truly unknown values reported under `other`.
 */
function foldStatusCounts(rows) {
  const out = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  let other = 0;
  for (const r of rows) {
    const { status } = normalizeOrderStatus(r._id);
    if (status) out[status] += r.n; else other += r.n;
  }
  return { counts: out, other };
}

module.exports = {
  STORED_VALUES, TERMINAL_STORED_VALUES,
  statusFilterCondition, notTerminalCondition, foldStatusCounts,
  ORDER_STATUSES, ORDER_STATUS_LABELS, LEGACY_STATUS_MAP, LEGACY_DB_VALUES,
  TERMINAL_STATUSES, OPEN_STATUSES, READY_STATUSES, COLLECTED_STATUSES, PRE_READY_STATUSES,
  normalizeOrderStatus, isOrderStatus,
};
