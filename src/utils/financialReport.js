// ─── Financial reporting — the ONE place money is calculated ────────────────
//
// Source of truth (see the implementation report for the evidence):
//   • Online order payments  → PaystackTransaction {type:'order', status:'paid'}
//                              (only set by the verified webhook / verify flow)
//   • Wallet order payments  → WalletTransaction {type:'debit',  source:'order'}
//   • Wallet refunds         → WalletTransaction {type:'credit', source:'order'}
//   • Cash / POS / transfer / card → the order's own record (payment.amount,
//                              payment.paidAt, payment.method). There is NO
//                              per-instalment ledger for these, so the amount
//                              not already explained by the two ledgers above is
//                              attributed to payment.paidAt (the last payment).
// Wallet TOP-UPS (source 'paystack'/'admin'/…) and subscription payments are
// never included, so a top-up followed by a wallet-funded order is counted once.
//
// Everything is derived read-only; nothing here writes to any financial record.

const Order = require('../models/Order.js');
const PaystackTransaction = require('../models/PaystackTransaction.js');
const WalletTransaction = require('../models/WalletTransaction.js');

const WAT_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos is a fixed UTC+1 (no DST)
const EPS = 0.01;
const MANUAL_STATUSES = ['paid', 'partial', 'refunded'];
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ── Time (business timezone: WAT) ───────────────────────────────────────────
function monthRange(year, month) {
  const y = Number(year); const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || !Number.isInteger(m) || m < 1 || m > 12) return null;
  return {
    from: new Date(Date.UTC(y, m - 1, 1) - WAT_OFFSET_MS),
    to: new Date(Date.UTC(y, m, 1) - WAT_OFFSET_MS), // exclusive
    year: y, month: m,
    daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate(),
  };
}
const watDay = (d) => new Date(new Date(d).getTime() + WAT_OFFSET_MS).toISOString().slice(0, 10);
const watMonthKey = (d) => watDay(d).slice(0, 7);
const inRange = (d, range) => d >= range.from && d < range.to;

// ── Ledger ──────────────────────────────────────────────────────────────────
const NUM_FROM_REASON = /(?:order\s+|—\s*)([A-Za-z0-9-]+)\s*$/;

async function walletOrderTx(extra) {
  const rows = await WalletTransaction.find({ source: 'order', ...extra })
    .select('type amount orderId reason createdAt').lean();
  // Older rows lost orderId to a schema gap; the order number is in the reason.
  const orphans = rows.filter((r) => !r.orderId);
  if (orphans.length) {
    const nums = [...new Set(orphans.map((r) => (NUM_FROM_REASON.exec(r.reason || '') || [])[1]).filter(Boolean))];
    const orders = nums.length ? await Order.find({ orderNumber: { $in: nums } }).select('orderNumber').lean() : [];
    const byNum = new Map(orders.map((o) => [o.orderNumber, o._id]));
    for (const r of orphans) {
      const n = (NUM_FROM_REASON.exec(r.reason || '') || [])[1];
      if (n && byNum.has(n)) { r.orderId = byNum.get(n); r.recovered = true; }
    }
  }
  return rows.filter((r) => r.orderId);
}

/**
 * Every money-in / money-out event in [from, to) (all time when no range).
 * Returns { payments:[], refunds:[] }; each {orderId, at, amount, method, reference, source}.
 */
async function loadEvents(range) {
  const payments = [];
  const refunds = [];
  const when = (field) => (range ? { [field]: { $gte: range.from, $lt: range.to } } : {});

  // 1. Verified Paystack order payments
  const ps = await PaystackTransaction.find({
    type: 'order', status: 'paid', orderId: { $ne: null },
    ...(range ? { $or: [
      { paidAt: { $gte: range.from, $lt: range.to } },
      { paidAt: null, updatedAt: { $gte: range.from, $lt: range.to } },
    ] } : {}),
  }).select('amount orderId paidAt updatedAt reference').lean();
  for (const t of ps) {
    payments.push({ orderId: t.orderId, at: t.paidAt || t.updatedAt, amount: t.amount, method: 'paystack', reference: t.reference, source: 'paystack' });
  }

  // 2/3. Wallet debits (payments) and credits (refunds) tied to an order
  const wtx = await walletOrderTx(when('createdAt'));
  for (const w of wtx) {
    const ev = { orderId: w.orderId, at: w.createdAt, amount: w.amount, method: 'wallet', reference: null, source: 'wallet' };
    if (w.type === 'debit') payments.push(ev); else refunds.push(ev);
  }

  // 4. Manual payments recorded on the order (cash / pos / transfer / card …)
  const manualOrders = await Order.find({
    'payment.amount': { $gt: 0 },
    paymentStatus: { $in: MANUAL_STATUSES },
    ...when('payment.paidAt'),
  }).select('payment paymentStatus').lean();
  if (manualOrders.length) {
    const ids = manualOrders.map((o) => o._id);
    const [psAll, wAll] = await Promise.all([
      PaystackTransaction.aggregate([
        { $match: { type: 'order', status: 'paid', orderId: { $in: ids } } },
        { $group: { _id: '$orderId', sum: { $sum: '$amount' } } },
      ]),
      walletOrderTx({ type: 'debit', orderId: { $in: ids } }),
    ]);
    const explained = new Map(psAll.map((r) => [String(r._id), r.sum]));
    for (const w of wAll) explained.set(String(w.orderId), (explained.get(String(w.orderId)) || 0) + w.amount);
    for (const o of manualOrders) {
      const residual = r2((o.payment.amount || 0) - (explained.get(String(o._id)) || 0));
      if (residual > EPS) {
        payments.push({
          orderId: o._id, at: o.payment.paidAt, amount: residual,
          method: o.payment.method || 'unknown', reference: o.payment.transactionId || null, source: 'order-record',
        });
      }
    }
  }
  return { payments, refunds };
}

// Orders that were refunded through the order record only (no ledger entry):
// money left the business but amount/date were never recorded.
async function loadUnrecordedRefunds() {
  const refundedOrders = await Order.find({ paymentStatus: 'refunded' }).select('orderNumber payment total').lean();
  if (!refundedOrders.length) return [];
  const ids = refundedOrders.map((o) => o._id);
  const credits = await walletOrderTx({ type: 'credit', orderId: { $in: ids } });
  const have = new Set(credits.map((c) => String(c.orderId)));
  return refundedOrders.filter((o) => !have.has(String(o._id)));
}

// ── Order helpers ───────────────────────────────────────────────────────────
function customerOf(o) {
  return {
    name: o.walkInCustomer?.name || o.customerId?.name || o.customer?.name || 'Walk-in',
    phone: o.walkInCustomer?.phone || o.customerId?.phone || o.customer?.phone || '',
    email: o.walkInCustomer?.email || o.customerId?.email || o.customer?.email || '',
  };
}
const discountOf = (o) => r2(Number(o.pricing?.discount ?? o.discountAmount ?? 0) || 0);
const levelOf = (o) => o.serviceLevelName || o.serviceLevel || 'Unspecified';

const ORDER_FIELDS = 'orderNumber total status paymentStatus createdAt payment pricing discountAmount '
  + 'serviceLevel serviceLevelName walkInCustomer customer customerId items.serviceName items.lineTotal items.total items.addons';
const populateCustomer = [
  { path: 'customer', select: 'name phone email' },
  { path: 'customerId', select: 'name phone email' },
];

function sumByOrder(events) {
  const m = new Map();
  for (const e of events) m.set(String(e.orderId), r2((m.get(String(e.orderId)) || 0) + e.amount));
  return m;
}

/** Effective payment state derived from the LEDGER, not from the stored flag. */
function derive(order, paid, refunded) {
  const net = r2(paid - refunded);
  if (order.status === 'cancelled') return { state: 'cancelled', net, outstanding: 0 };
  if (refunded > EPS && net <= EPS) return { state: 'refunded', net, outstanding: 0 };
  const total = order.total || 0;
  const outstanding = r2(Math.max(0, total - net));
  if (total > 0 && net >= total - EPS) return { state: 'paid', net, outstanding: 0 };
  if (net > EPS) return { state: 'partial', net, outstanding };
  return { state: 'unpaid', net, outstanding };
}

/** Where the stored flag and the ledger disagree. Reported, never "fixed". */
function anomalyOf(order, paid, refunded, d) {
  const stored = order.paymentStatus;
  if (order.status === 'cancelled') {
    if (d.net > EPS && stored !== 'refunded') return 'cancelled_with_money_held';
    return null;
  }
  if (stored === 'paid' && d.state !== 'paid') return 'flag_paid_but_ledger_short';
  if (stored === 'partial' && d.state === 'paid') return 'flag_partial_but_ledger_paid';
  if (stored === 'unpaid' && d.net > EPS) return 'flag_unpaid_but_ledger_has_payment';
  if (stored === 'refunded' && refunded <= EPS) return 'flag_refunded_without_refund_record';
  if (d.net > (order.total || 0) + EPS) return 'overpaid';
  return null;
}

async function ordersByIds(ids) {
  if (!ids.length) return new Map();
  const rows = await Order.find({ _id: { $in: ids } }).select(ORDER_FIELDS).populate(populateCustomer).lean();
  return new Map(rows.map((o) => [String(o._id), o]));
}

function matchesSearch(order, q) {
  if (!q) return true;
  const c = customerOf(order);
  const s = q.toLowerCase();
  return [order.orderNumber, c.name, c.phone, c.email].some((v) => String(v || '').toLowerCase().includes(s));
}

function paginate(rows, page, limit) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  return { rows: rows.slice((p - 1) * l, p * l), page: p, limit: l, total: rows.length, pages: Math.max(1, Math.ceil(rows.length / l)) };
}

// ── Payment-month report (cash actually received) ───────────────────────────
async function paymentMonthModel(range) {
  const { payments, refunds } = await loadEvents(range);
  const grossTotal = r2(payments.reduce((s, e) => s + e.amount, 0));
  const refundTotal = r2(refunds.reduce((s, e) => s + e.amount, 0));

  const orderIds = [...new Set([...payments, ...refunds].map((e) => String(e.orderId)))];
  const orders = await ordersByIds(orderIds);

  // Money to date for those orders (for balance columns) — all-time events.
  const [allPay, allRef] = await Promise.all(
    orderIds.length ? [loadEventsForOrders(orderIds)] : [Promise.resolve({ payments: [], refunds: [] })]
  ).then(([x]) => [x.payments, x.refunds]);
  const paidToDate = sumByOrder(allPay);
  const refundedToDate = sumByOrder(allRef);

  const byMethod = {};
  const byDay = {};
  const byLevel = {};
  const touch = (map, key) => (map[key] ||= { gross: 0, refunds: 0, count: 0 });
  for (const e of payments) {
    touch(byMethod, e.method).gross += e.amount; byMethod[e.method].count += 1;
    touch(byDay, watDay(e.at)).gross += e.amount; byDay[watDay(e.at)].count += 1;
    const lvl = levelOf(orders.get(String(e.orderId)) || {});
    touch(byLevel, lvl).gross += e.amount; byLevel[lvl].count += 1;
  }
  for (const e of refunds) {
    touch(byMethod, e.method).refunds += e.amount;
    touch(byDay, watDay(e.at)).refunds += e.amount;
    touch(byLevel, levelOf(orders.get(String(e.orderId)) || {})).refunds += e.amount;
  }

  // One row per order that received money this month
  const rowsByOrder = new Map();
  for (const e of payments) {
    const o = orders.get(String(e.orderId));
    if (!o) continue;
    const k = String(e.orderId);
    const row = rowsByOrder.get(k) || {
      orderId: k, orderNumber: o.orderNumber, customer: customerOf(o), orderDate: o.createdAt,
      paidDate: e.at, total: o.total || 0, discount: discountOf(o), paidThisMonth: 0,
      methods: new Set(), references: new Set(), orderStatus: o.status, storedPaymentStatus: o.paymentStatus,
    };
    row.paidThisMonth = r2(row.paidThisMonth + e.amount);
    if (e.at > row.paidDate) row.paidDate = e.at;
    row.methods.add(e.method);
    if (e.reference) row.references.add(e.reference);
    rowsByOrder.set(k, row);
  }
  const paidRows = [...rowsByOrder.values()].map((r) => {
    const o = orders.get(r.orderId);
    const paid = paidToDate.get(r.orderId) || 0;
    const ref = refundedToDate.get(r.orderId) || 0;
    const d = derive(o, paid, ref);
    return {
      ...r, methods: [...r.methods], references: [...r.references],
      paidToDate: r2(paid), refundedToDate: r2(ref), outstanding: d.outstanding, paymentState: d.state,
    };
  }).sort((a, b) => new Date(b.paidDate) - new Date(a.paidDate));

  return { payments, refunds, grossTotal, refundTotal, byMethod, byDay, byLevel, paidRows, orders };
}

async function loadEventsForOrders(orderIds) {
  const ids = orderIds;
  const [ps, wtx, manual] = await Promise.all([
    PaystackTransaction.find({ type: 'order', status: 'paid', orderId: { $in: ids } }).select('amount orderId paidAt updatedAt reference').lean(),
    walletOrderTx({ orderId: { $in: ids } }),
    Order.find({ _id: { $in: ids }, 'payment.amount': { $gt: 0 }, paymentStatus: { $in: MANUAL_STATUSES } }).select('payment').lean(),
  ]);
  const payments = ps.map((t) => ({ orderId: t.orderId, at: t.paidAt || t.updatedAt, amount: t.amount, method: 'paystack', reference: t.reference }));
  const refunds = [];
  const explained = new Map();
  for (const t of ps) explained.set(String(t.orderId), (explained.get(String(t.orderId)) || 0) + t.amount);
  for (const w of wtx) {
    if (w.type === 'debit') {
      payments.push({ orderId: w.orderId, at: w.createdAt, amount: w.amount, method: 'wallet' });
      explained.set(String(w.orderId), (explained.get(String(w.orderId)) || 0) + w.amount);
    } else refunds.push({ orderId: w.orderId, at: w.createdAt, amount: w.amount, method: 'wallet' });
  }
  for (const o of manual) {
    const residual = r2((o.payment.amount || 0) - (explained.get(String(o._id)) || 0));
    if (residual > EPS) payments.push({ orderId: o._id, at: o.payment.paidAt, amount: residual, method: o.payment.method || 'unknown', reference: o.payment.transactionId || null });
  }
  return { payments, refunds };
}

// ── Order-month report (business created) ───────────────────────────────────
async function orderMonthModel(range, { search } = {}) {
  const orders = await Order.find({ createdAt: { $gte: range.from, $lt: range.to }, status: { $ne: 'draft' } })
    .select(ORDER_FIELDS).populate(populateCustomer).lean();
  const ids = orders.map((o) => o._id);
  const ev = ids.length ? await loadEventsForOrders(ids) : { payments: [], refunds: [] };
  const paid = sumByOrder(ev.payments);
  const refunded = sumByOrder(ev.refunds);

  const totals = {
    ordersCreated: 0, orderValue: 0, discounts: 0, grossOrderValue: 0, amountPaid: 0, outstandingBalance: 0,
    paid: 0, partial: 0, unpaid: 0, refunded: 0, cancelled: 0, outstandingOrders: 0, cancelledValue: 0,
  };
  const byDay = {}; const byLevel = {}; const byService = {}; const byAddon = {}; const byCustomer = {};
  const rows = [];
  for (const o of orders) {
    const id = String(o._id);
    const d = derive(o, paid.get(id) || 0, refunded.get(id) || 0);
    const total = o.total || 0;
    const disc = discountOf(o);
    totals.ordersCreated += 1;
    const day = (byDay[watDay(o.createdAt)] ||= { orders: 0, value: 0, paid: 0, outstanding: 0 });
    day.orders += 1;
    if (d.state === 'cancelled') { totals.cancelled += 1; totals.cancelledValue += total; rows.push({ o, d }); continue; }
    totals.orderValue += total; totals.discounts += disc; totals.grossOrderValue += total + disc;
    totals.amountPaid += Math.max(0, d.net); totals.outstandingBalance += d.outstanding;
    if (d.outstanding > EPS) totals.outstandingOrders += 1;
    totals[d.state] += 1;
    day.value += total; day.paid += Math.max(0, d.net); day.outstanding += d.outstanding;
    const lvl = (byLevel[levelOf(o)] ||= { orders: 0, value: 0, paid: 0, outstanding: 0 });
    lvl.orders += 1; lvl.value += total; lvl.paid += Math.max(0, d.net); lvl.outstanding += d.outstanding;
    for (const it of o.items || []) {
      const key = it.serviceName || 'Other';
      const s = (byService[key] ||= { lines: 0, value: 0 });
      s.lines += 1; s.value += it.total || 0;
      for (const a of it.addons || []) {
        const ad = (byAddon[a.name || 'Add-on'] ||= { uses: 0, value: 0 });
        ad.uses += a.quantity || 1; ad.value += a.total || 0;
      }
    }
    const c = customerOf(o);
    const ck = `${c.name}|${c.phone}`;
    const cu = (byCustomer[ck] ||= { name: c.name, phone: c.phone, orders: 0, value: 0, paid: 0, outstanding: 0 });
    cu.orders += 1; cu.value += total; cu.paid += Math.max(0, d.net); cu.outstanding += d.outstanding;
    rows.push({ o, d });
  }
  for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);
  return { totals, byDay, byLevel, byService, byAddon, byCustomer, rows };
}

const roundMap = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, typeof b === 'number' ? r2(b) : b]))]));

// ── Outstanding (all-time, as of now) ───────────────────────────────────────
async function outstandingModel({ search } = {}) {
  const candidates = await Order.find({
    status: { $nin: ['cancelled', 'draft'] },
    paymentStatus: { $in: ['unpaid', 'partial'] },
  }).select(ORDER_FIELDS).populate(populateCustomer).lean();
  const ev = candidates.length ? await loadEventsForOrders(candidates.map((o) => o._id)) : { payments: [], refunds: [] };
  const paid = sumByOrder(ev.payments);
  const refunded = sumByOrder(ev.refunds);
  const now = Date.now();
  const rows = [];
  for (const o of candidates) {
    const id = String(o._id);
    const d = derive(o, paid.get(id) || 0, refunded.get(id) || 0);
    if (d.outstanding <= EPS) continue;
    if (!matchesSearch(o, search)) continue;
    rows.push({
      orderId: id, orderNumber: o.orderNumber, customer: customerOf(o), orderDate: o.createdAt,
      total: o.total || 0, amountPaid: Math.max(0, d.net), outstanding: d.outstanding,
      paymentState: d.state, storedPaymentStatus: o.paymentStatus, orderStatus: o.status,
      ageDays: Math.floor((now - new Date(o.createdAt).getTime()) / 86400000),
    });
  }
  rows.sort((a, b) => b.outstanding - a.outstanding);
  return {
    rows,
    totals: { orders: rows.length, outstandingBalance: r2(rows.reduce((s, r) => s + r.outstanding, 0)), partial: rows.filter((r) => r.paymentState === 'partial').length },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────
async function getSummary(range) {
  const [pm, om, out, unrecorded] = await Promise.all([
    paymentMonthModel(range), orderMonthModel(range), outstandingModel(), loadUnrecordedRefunds(),
  ]);
  const net = r2(pm.grossTotal - pm.refundTotal);

  // Reconciliation: the same net, rebuilt through every grouping used on screen.
  const sum = (m, f) => r2(Object.values(m).reduce((s, v) => s + f(v), 0));
  const checks = {
    methods: sum(pm.byMethod, (v) => v.gross - v.refunds),
    days: sum(pm.byDay, (v) => v.gross - v.refunds),
    serviceLevels: sum(pm.byLevel, (v) => v.gross - v.refunds),
    paidOrdersTable: r2(pm.paidRows.reduce((s, r) => s + r.paidThisMonth, 0)),
  };
  const reconciliation = {
    ok: Math.abs(checks.methods - net) < EPS && Math.abs(checks.days - net) < EPS
      && Math.abs(checks.serviceLevels - net) < EPS && Math.abs(checks.paidOrdersTable - pm.grossTotal) < EPS,
    net, grossPaymentsTableTotal: checks.paidOrdersTable, ...checks,
  };

  const daily = [];
  for (let d = 1; d <= range.daysInMonth; d += 1) {
    const key = `${range.year}-${String(range.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const v = pm.byDay[key] || { gross: 0, refunds: 0, count: 0 };
    daily.push({ date: key, collected: r2(v.gross), refunds: r2(v.refunds), net: r2(v.gross - v.refunds), transactions: v.count });
  }
  const orderDaily = Object.entries(om.byDay).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, orders: v.orders, value: r2(v.value), paid: r2(v.paid), outstanding: r2(v.outstanding) }));

  return {
    period: { year: range.year, month: range.month, timezone: 'Africa/Lagos', from: range.from, to: range.to },
    financial: {
      basis: 'payment date',
      grossCollected: pm.grossTotal, refunds: pm.refundTotal, netCollected: net,
      paymentTransactions: pm.payments.length, paidOrders: pm.paidRows.length,
      methods: Object.entries(pm.byMethod).map(([method, v]) => ({ method, collected: r2(v.gross), refunds: r2(v.refunds), net: r2(v.gross - v.refunds), transactions: v.count })),
      serviceLevels: Object.entries(pm.byLevel).map(([level, v]) => ({ level, collected: r2(v.gross), refunds: r2(v.refunds), net: r2(v.gross - v.refunds) })),
      daily,
    },
    orders: {
      basis: 'order creation date',
      ...om.totals,
      daily: orderDaily,
      serviceLevels: Object.entries(roundMap(om.byLevel)).map(([level, v]) => ({ level, ...v })),
      services: Object.entries(roundMap(om.byService)).map(([service, v]) => ({ service, ...v })).sort((a, b) => b.value - a.value),
      addons: Object.entries(roundMap(om.byAddon)).map(([addon, v]) => ({ addon, ...v })).sort((a, b) => b.value - a.value),
      customers: Object.values(om.byCustomer).sort((a, b) => b.value - a.value).slice(0, 20)
        .map((c) => ({ ...c, value: r2(c.value), paid: r2(c.paid), outstanding: r2(c.outstanding) })),
    },
    outstanding: out.totals,
    unrecordedRefunds: { orders: unrecorded.length, amount: r2(unrecorded.reduce((s, o) => s + (o.payment?.amount || 0), 0)) },
    reconciliation,
    notes: [
      'Collected revenue is money received by payment date. Order totals are reported separately by creation date.',
      'Wallet top-ups are not revenue; only wallet payments applied to orders are counted.',
      'Cash/POS/transfer payments have no per-instalment record; the amount is dated to the last recorded payment.',
    ],
  };
}

async function getPaidOrders(range, { search, page, limit } = {}) {
  const pm = await paymentMonthModel(range);
  const q = String(search || '').toLowerCase();
  const rows = pm.paidRows.filter((r) => !q
    || [r.orderNumber, r.customer.name, r.customer.phone, r.customer.email].some((v) => String(v || '').toLowerCase().includes(q)));
  const filteredTotal = r2(rows.reduce((s, r) => s + r.paidThisMonth, 0));
  return { ...paginate(rows, page, limit), totals: { orders: rows.length, collected: filteredTotal }, allRows: rows };
}

async function getOutstanding({ search, page, limit } = {}) {
  const out = await outstandingModel({ search });
  return { ...paginate(out.rows, page, limit), totals: out.totals, allRows: out.rows };
}

async function getTrend(endYear, endMonth, months = 12) {
  const end = monthRange(endYear, endMonth);
  const startDate = new Date(Date.UTC(end.year, end.month - months, 1) - WAT_OFFSET_MS);
  const range = { from: startDate, to: end.to };
  const { payments, refunds } = await loadEvents(range);
  const buckets = {};
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(end.year, end.month - 1 - i, 1));
    buckets[d.toISOString().slice(0, 7)] = { collected: 0, refunds: 0 };
  }
  for (const e of payments) { const k = watMonthKey(e.at); if (buckets[k]) buckets[k].collected += e.amount; }
  for (const e of refunds) { const k = watMonthKey(e.at); if (buckets[k]) buckets[k].refunds += e.amount; }
  return Object.entries(buckets).map(([month, v]) => ({ month, collected: r2(v.collected), refunds: r2(v.refunds), net: r2(v.collected - v.refunds) }));
}

async function getAnomalies({ limit = 100 } = {}) {
  const orders = await Order.find({ status: { $ne: 'draft' } }).select(ORDER_FIELDS).lean();
  const ev = orders.length ? await loadEventsForOrders(orders.map((o) => o._id)) : { payments: [], refunds: [] };
  const paid = sumByOrder(ev.payments);
  const refunded = sumByOrder(ev.refunds);
  const counts = {}; const samples = [];
  for (const o of orders) {
    const id = String(o._id);
    const p = paid.get(id) || 0; const rf = refunded.get(id) || 0;
    const kind = anomalyOf(o, p, rf, derive(o, p, rf));
    if (!kind) continue;
    counts[kind] = (counts[kind] || 0) + 1;
    if (samples.length < limit) samples.push({ orderNumber: o.orderNumber, kind, total: o.total || 0, ledgerPaid: p, ledgerRefunded: rf, storedPaymentStatus: o.paymentStatus, orderStatus: o.status });
  }
  return { scanned: orders.length, counts, samples };
}

module.exports = {
  monthRange, watDay, derive, getSummary, getPaidOrders, getOutstanding, getTrend, getAnomalies, loadEventsForOrders, EPS, r2,
};
