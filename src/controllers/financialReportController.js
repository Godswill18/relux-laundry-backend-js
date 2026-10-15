// Financial reports — read-only. Access: developer (the app's "Superadmin") only,
// enforced here in the backend independently of any frontend check.
const ExcelJS = require('exceljs');
const asyncHandler = require('../utils/asyncHandler.js');
const AppError = require('../utils/appError.js');
const { logAudit } = require('../utils/auditLogger.js');
const fin = require('../utils/financialReport.js');

// Deliberately NOT authorize(): that helper always lets 'developer' through and
// is meant for broader role lists. Here the allow-list is exactly these roles.
const FINANCIAL_ROLES = ['developer', 'superadmin'];
exports.requireFinancialAccess = (req, res, next) => {
  if (!req.user || !FINANCIAL_ROLES.includes(req.user.role)) {
    return next(new AppError('Forbidden', 403));
  }
  next();
};

function periodFrom(req, next) {
  const now = new Date(Date.now() + 3600000);
  const year = req.query.year || now.getUTCFullYear();
  const month = req.query.month || now.getUTCMonth() + 1;
  const range = fin.monthRange(year, month);
  if (!range) { next(new AppError('Invalid year or month', 400)); return null; }
  return range;
}

const audit = (req, action, extra = {}) => logAudit({
  actorUserId: req.user.id,
  action,
  targetType: 'FinancialReport',
  targetId: `${req.query.year || ''}-${req.query.month || ''}`,
  metadata: { role: req.user.role, year: req.query.year, month: req.query.month, search: req.query.search, ...extra },
});

exports.summary = asyncHandler(async (req, res, next) => {
  const range = periodFrom(req, next); if (!range) return;
  const data = await fin.getSummary(range);
  await audit(req, 'FINANCIAL_REPORT_VIEWED', { section: 'summary' });
  res.status(200).json({ success: true, message: 'Financial summary fetched', data });
});

exports.paidOrders = asyncHandler(async (req, res, next) => {
  const range = periodFrom(req, next); if (!range) return;
  const { allRows, ...data } = await fin.getPaidOrders(range, req.query);
  res.status(200).json({ success: true, message: 'Paid orders fetched', data });
});

exports.outstandingOrders = asyncHandler(async (req, res) => {
  const { allRows, ...data } = await fin.getOutstanding(req.query);
  res.status(200).json({ success: true, message: 'Outstanding orders fetched', data });
});

exports.trend = asyncHandler(async (req, res, next) => {
  const range = periodFrom(req, next); if (!range) return;
  const data = await fin.getTrend(range.year, range.month, 12);
  res.status(200).json({ success: true, message: 'Revenue trend fetched', data: { months: data } });
});

exports.anomalies = asyncHandler(async (req, res) => {
  const data = await fin.getAnomalies();
  await audit(req, 'FINANCIAL_REPORT_VIEWED', { section: 'anomalies' });
  res.status(200).json({ success: true, message: 'Reconciliation anomalies fetched', data });
});

// Same service, same filters as the screen — nothing is recalculated here.
exports.exportReport = asyncHandler(async (req, res, next) => {
  const range = periodFrom(req, next); if (!range) return;
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const [summary, paid, out] = await Promise.all([
    fin.getSummary(range), fin.getPaidOrders(range, {}), fin.getOutstanding({}),
  ]);
  await audit(req, 'FINANCIAL_REPORT_EXPORTED', { format });
  const name = `financial-report-${range.year}-${String(range.month).padStart(2, '0')}`;
  const generated = { generatedAt: new Date().toISOString(), generatedBy: req.user.name || String(req.user.id) };

  if (format === 'csv') {
    const esc = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) || /[",\n]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
    const lines = [
      `Financial report,${range.year}-${String(range.month).padStart(2, '0')},Generated,${generated.generatedAt},By,${esc(generated.generatedBy)}`,
      `Gross collected,${summary.financial.grossCollected},Refunds,${summary.financial.refunds},Net collected,${summary.financial.netCollected}`,
      '', 'PAID ORDERS (by payment date)',
      'Order,Customer,Order date,Paid date,Order total,Paid this month,Paid to date,Outstanding,Methods,Payment state,Order status',
      ...paid.allRows.map((r) => [r.orderNumber, r.customer.name, r.orderDate?.toISOString?.().slice(0, 10), r.paidDate?.toISOString?.().slice(0, 10), r.total, r.paidThisMonth, r.paidToDate, r.outstanding, r.methods.join('/'), r.paymentState, r.orderStatus].map(esc).join(',')),
      `Total paid orders,${paid.totals.orders},Total collected,${paid.totals.collected}`,
      '', 'OUTSTANDING ORDERS (as of now)',
      'Order,Customer,Order date,Order total,Amount paid,Outstanding,Payment state,Order status,Age (days)',
      ...out.allRows.map((r) => [r.orderNumber, r.customer.name, r.orderDate?.toISOString?.().slice(0, 10), r.total, r.amountPaid, r.outstanding, r.paymentState, r.orderStatus, r.ageDays].map(esc).join(',')),
      `Outstanding orders,${out.totals.orders},Outstanding balance,${out.totals.outstandingBalance}`,
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.status(200).send(lines.join('\n'));
  }

  const wb = new ExcelJS.Workbook();
  const add = (title, cols, rows) => {
    const ws = wb.addWorksheet(title);
    ws.columns = cols.map(([header, key, width]) => ({ header, key, width: width || 16 }));
    rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
  };
  add('Summary', [['Metric', 'k', 32], ['Value', 'v', 22]], [
    { k: 'Period', v: `${range.year}-${String(range.month).padStart(2, '0')} (Africa/Lagos)` },
    { k: 'Generated at', v: generated.generatedAt }, { k: 'Generated by', v: generated.generatedBy },
    { k: 'Gross collected (by payment date)', v: summary.financial.grossCollected },
    { k: 'Refunds', v: summary.financial.refunds }, { k: 'Net collected', v: summary.financial.netCollected },
    { k: 'Orders created (by order date)', v: summary.orders.ordersCreated }, { k: 'Order value', v: summary.orders.orderValue },
    { k: 'Outstanding orders (all time)', v: summary.outstanding.orders }, { k: 'Outstanding balance (all time)', v: summary.outstanding.outstandingBalance },
  ]);
  add('Paid Orders', [['Order', 'orderNumber', 18], ['Customer', 'c', 24], ['Order date', 'orderDate', 14], ['Paid date', 'paidDate', 14], ['Order total', 'total'], ['Paid this month', 'paidThisMonth'], ['Paid to date', 'paidToDate'], ['Outstanding', 'outstanding'], ['Methods', 'm'], ['Payment state', 'paymentState'], ['Order status', 'orderStatus']],
    paid.allRows.map((r) => ({ ...r, c: r.customer.name, m: r.methods.join('/'), orderDate: r.orderDate?.toISOString?.().slice(0, 10), paidDate: r.paidDate?.toISOString?.().slice(0, 10) })));
  add('Outstanding', [['Order', 'orderNumber', 18], ['Customer', 'c', 24], ['Order date', 'orderDate', 14], ['Order total', 'total'], ['Amount paid', 'amountPaid'], ['Outstanding', 'outstanding'], ['Payment state', 'paymentState'], ['Order status', 'orderStatus'], ['Age (days)', 'ageDays']],
    out.allRows.map((r) => ({ ...r, c: r.customer.name, orderDate: r.orderDate?.toISOString?.().slice(0, 10) })));
  add('Payment Methods', [['Method', 'method'], ['Collected', 'collected'], ['Refunds', 'refunds'], ['Net', 'net'], ['Transactions', 'transactions']], summary.financial.methods);
  add('Daily', [['Date', 'date'], ['Collected', 'collected'], ['Refunds', 'refunds'], ['Net', 'net'], ['Transactions', 'transactions']], summary.financial.daily);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
