const Order = require('../models/Order.js');
const asyncHandler = require('../utils/asyncHandler.js');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFilter(query) {
  const filter = {};

  if (query.startDate || query.endDate) {
    filter.createdAt = {};
    if (query.startDate) filter.createdAt.$gte = new Date(query.startDate + 'T00:00:00.000Z');
    if (query.endDate) {
      const end = new Date(query.endDate + 'T23:59:59.999Z');
      filter.createdAt.$lte = end;
    }
  }
  if (query.status)        filter.status        = query.status;
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
  if (query.orderType)     filter.orderType     = query.orderType;

  return filter;
}

async function fetchOrders(filter) {
  return Order.find(filter)
    .populate('customer',      'name email phone')
    .populate('customerId',    'name email phone')
    .populate('assignedStaff', 'name')
    .populate('deliveredBy',   'name')
    .populate('pickupWindowId','label startTime endTime')
    .populate('deliveryZoneId','name')
    .sort('-createdAt')
    .lean();
}

function buildFilename(query, ext) {
  const start = query.startDate || 'all';
  const end   = query.endDate   || 'all';
  return `orders-report-${start}_to_${end}.${ext}`;
}

function resolveCustomer(order) {
  return {
    name:  order.walkInCustomer?.name  || order.customerId?.name  || order.customer?.name  || 'N/A',
    phone: order.walkInCustomer?.phone || order.customerId?.phone || order.customer?.phone || 'N/A',
    email: order.customerId?.email || order.customer?.email || 'N/A',
  };
}

function formatItems(order) {
  if (!Array.isArray(order.items) || order.items.length === 0) return 'N/A';
  return order.items
    .map((i) => `${i.categoryName || i.itemType || 'Item'} x${i.quantity}`)
    .join(', ');
}

function formatAddons(order) {
  if (!Array.isArray(order.addons) || order.addons.length === 0) return 'None';
  return order.addons.map((a) => a.name || 'Addon').join(', ');
}

function formatPickup(order) {
  if (!order.pickupWindowId) return order.scheduledPickupTime || 'N/A';
  const w = order.pickupWindowId;
  const label = w.label || `${w.startTime}–${w.endTime}`;
  if (order.pickupDate) {
    const d = new Date(order.pickupDate);
    return `${d.toLocaleDateString('en-NG')} ${label}`;
  }
  return label;
}

// ─── Excel Export ─────────────────────────────────────────────────────────────

exports.exportOrdersExcel = asyncHandler(async (req, res) => {
  const filter = buildFilter(req.query);
  const orders = await fetchOrders(filter);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Relux Laundry';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Orders', {
    views: [{ state: 'frozen', ySplit: 3 }],
  });

  // ── Title rows ───────────────────────────────────────────────────────────
  const COLS = 19;

  sheet.mergeCells(1, 1, 1, COLS);
  const titleCell = sheet.getCell('A1');
  titleCell.value = 'Relux Laundry — Orders Report';
  titleCell.font  = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  titleCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2B4C' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 32;

  sheet.mergeCells(2, 1, 2, COLS);
  const subCell = sheet.getCell('A2');
  const rangeText = (req.query.startDate && req.query.endDate)
    ? `Date Range: ${req.query.startDate} to ${req.query.endDate}`
    : req.query.startDate ? `From: ${req.query.startDate}`
    : req.query.endDate   ? `To: ${req.query.endDate}`
    : 'All dates';
  subCell.value = `${rangeText}   |   Total Records: ${orders.length}   |   Generated: ${new Date().toLocaleString('en-NG')}`;
  subCell.font  = { italic: true, size: 10, color: { argb: 'FF444444' } };
  subCell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EFF8' } };
  subCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).height = 22;

  // ── Columns ──────────────────────────────────────────────────────────────
  sheet.columns = [
    { header: 'Order #',         key: 'orderNumber',    width: 16 },
    { header: 'Date',            key: 'date',           width: 20 },
    { header: 'Status',          key: 'status',         width: 16 },
    { header: 'Payment Status',  key: 'paymentStatus',  width: 16 },
    { header: 'Order Type',      key: 'orderType',      width: 15 },
    { header: 'Customer Name',   key: 'customerName',   width: 22 },
    { header: 'Phone',           key: 'phone',          width: 16 },
    { header: 'Email',           key: 'email',          width: 26 },
    { header: 'Items',           key: 'items',          width: 35 },
    { header: 'Add-ons',         key: 'addons',         width: 22 },
    { header: 'Service Level',   key: 'serviceLevel',   width: 16 },
    { header: 'Pickup Schedule', key: 'pickupSchedule', width: 22 },
    { header: 'Delivery Zone',   key: 'deliveryZone',   width: 16 },
    { header: 'Subtotal (₦)',    key: 'subtotal',       width: 16 },
    { header: 'Pickup Fee (₦)',  key: 'pickupFee',      width: 15 },
    { header: 'Delivery Fee (₦)',key: 'deliveryFee',    width: 16 },
    { header: 'Discount (₦)',    key: 'discount',       width: 15 },
    { header: 'Add-ons Fee (₦)', key: 'addonsFee',      width: 16 },
    { header: 'Total (₦)',       key: 'total',          width: 15 },
    { header: 'Assigned Staff',  key: 'assignedStaff',  width: 20 },
    { header: 'Delivered By',    key: 'deliveredBy',    width: 20 },
    { header: 'Notes',           key: 'notes',          width: 30 },
  ];

  // ── Header row styling (row 3 because rows 1-2 are title) ───────────────
  // Re-set headers at row 3
  const headers = [
    'Order #','Date','Status','Payment Status','Order Type','Customer Name',
    'Phone','Email','Items','Add-ons','Service Level','Pickup Schedule',
    'Delivery Zone','Subtotal (₦)','Pickup Fee (₦)','Delivery Fee (₦)',
    'Discount (₦)','Add-ons Fee (₦)','Total (₦)','Assigned Staff',
    'Delivered By','Notes',
  ];
  const headerRow = sheet.getRow(3);
  headerRow.values = headers;
  headerRow.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  headerRow.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  headerRow.height = 26;

  // Reset column keys to match the explicit header row (row 3 is our header)
  const COLUMN_KEYS = [
    'orderNumber','date','status','paymentStatus','orderType','customerName',
    'phone','email','items','addons','serviceLevel','pickupSchedule',
    'deliveryZone','subtotal','pickupFee','deliveryFee','discount',
    'addonsFee','total','assignedStaff','deliveredBy','notes',
  ];
  sheet.columns.forEach((col, i) => { col.key = COLUMN_KEYS[i]; });

  // ── Data rows ────────────────────────────────────────────────────────────
  const STATUS_COLORS = {
    pending:           'FFFEF3C7',
    confirmed:         'FFDBEAFE',
    'picked-up':       'FFE0E7FF',
    in_progress:       'FFF3E8FF',
    washing:           'FFE0F2FE',
    ironing:           'FFFCE7F3',
    ready:             'FFD1FAE5',
    'out-for-delivery':'FFFEF9C3',
    delivered:         'FFCFFAFE',
    completed:         'FFD1FAE5',
    cancelled:         'FFFEE2E2',
  };

  orders.forEach((order, idx) => {
    const cust = resolveCustomer(order);
    const p    = order.pricing || {};

    const rowData = [
      order.orderNumber || '—',
      order.createdAt ? new Date(order.createdAt).toLocaleString('en-NG') : 'N/A',
      order.status || 'N/A',
      order.paymentStatus || 'N/A',
      order.orderType || 'N/A',
      cust.name,
      cust.phone,
      cust.email,
      formatItems(order),
      formatAddons(order),
      order.serviceLevelName || order.serviceLevel || 'Standard',
      formatPickup(order),
      order.deliveryZoneId?.name || 'N/A',
      p.subtotal ?? 0,
      p.pickupFee ?? 0,
      p.deliveryFee ?? 0,
      p.discount ?? 0,
      p.addOnsFee ?? 0,
      p.total ?? order.total ?? 0,
      order.assignedStaff?.name || 'Unassigned',
      order.deliveredBy?.name || 'N/A',
      order.notes || '',
    ];

    const row = sheet.addRow(rowData);
    row.height = 18;

    // Alternating row fill, override with status color for status cell
    const baseFill = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF8FAFC';
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      cell.alignment = { vertical: 'middle', wrapText: colNum === 9 };
      cell.border = {
        top:    { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left:   { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right:  { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: baseFill } };
    });

    // Status cell color
    const statusCell = row.getCell(3);
    const statusColor = STATUS_COLORS[order.status] || 'FFFFFFFF';
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusColor } };
    statusCell.font = { bold: true, size: 9 };
    statusCell.alignment = { horizontal: 'center', vertical: 'middle' };

    // Currency formatting
    [14, 15, 16, 17, 18, 19].forEach((c) => {
      const cell = row.getCell(c);
      cell.numFmt = '#,##0.00';
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });
  });

  // ── Summary row ──────────────────────────────────────────────────────────
  if (orders.length > 0) {
    const lastRow = sheet.rowCount + 1;
    const summaryRow = sheet.getRow(lastRow + 1);
    summaryRow.getCell(1).value = 'TOTAL';
    summaryRow.getCell(1).font  = { bold: true };
    const totalRevenue = orders.reduce((s, o) => s + (o.pricing?.total ?? o.total ?? 0), 0);
    summaryRow.getCell(19).value = totalRevenue;
    summaryRow.getCell(19).numFmt = '#,##0.00';
    summaryRow.getCell(19).font  = { bold: true };
    summaryRow.getCell(19).alignment = { horizontal: 'right' };
  }

  // ── Respond ──────────────────────────────────────────────────────────────
  const filename = buildFilename(req.query, 'xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
});

// ─── PDF Export ───────────────────────────────────────────────────────────────

exports.exportOrdersPDF = asyncHandler(async (req, res) => {
  const filter = buildFilter(req.query);
  const orders = await fetchOrders(filter);

  const filename = buildFilename(req.query, 'pdf');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 30, autoFirstPage: true });
  doc.pipe(res);

  const PAGE_W     = doc.page.width  - 60;  // usable width (30pt margin each side)
  const PAGE_H     = doc.page.height - 60;
  const MARGIN_L   = 30;
  const HEADER_Y   = 30;
  const TABLE_TOP  = 110;
  const ROW_H      = 20;
  const COL_H_H    = 22;  // column header height

  // Columns: [label, width]
  const COLS = [
    ['Order #',      70],
    ['Date',         90],
    ['Customer',     100],
    ['Phone',        80],
    ['Status',       72],
    ['Payment',      58],
    ['Type',         60],
    ['Items',        130],
    ['Total (₦)',    72],
    ['Staff',        80],
  ];
  const tableWidth = COLS.reduce((s, c) => s + c[1], 0);

  // ── Page header painter (called for first + continuation pages) ──────────
  let pageNum = 1;
  function drawPageHeader() {
    const y = HEADER_Y;
    doc.rect(MARGIN_L, y, PAGE_W, 40).fill('#0F2B4C');
    doc.fillColor('#FFFFFF').fontSize(14).font('Helvetica-Bold')
      .text('Relux Laundry — Orders Report', MARGIN_L + 10, y + 6, { width: PAGE_W - 100 });

    const rangeText = (req.query.startDate && req.query.endDate)
      ? `${req.query.startDate} – ${req.query.endDate}`
      : req.query.startDate ? `From ${req.query.startDate}`
      : req.query.endDate   ? `To ${req.query.endDate}`
      : 'All dates';
    doc.fontSize(9).font('Helvetica')
      .text(`Date range: ${rangeText}`, MARGIN_L + 10, y + 24, { width: PAGE_W - 200 });

    // Record count + page number on right
    doc.fontSize(9).text(`${orders.length} records  |  Page ${pageNum}`, MARGIN_L, y + 6, {
      width: PAGE_W, align: 'right',
    });
    doc.fillColor('#000000');
  }

  // ── Summary stats bar ────────────────────────────────────────────────────
  function drawSummary() {
    const y = HEADER_Y + 48;
    const totalRev = orders.reduce((s, o) => s + (o.pricing?.total ?? o.total ?? 0), 0);
    const paid     = orders.filter(o => o.paymentStatus === 'paid').length;
    const pending  = orders.filter(o => o.status === 'pending').length;
    const completed= orders.filter(o => o.status === 'completed').length;

    const stats = [
      ['Total Orders',   orders.length],
      ['Completed',      completed],
      ['Pending',        pending],
      ['Paid',           paid],
      ['Total Revenue',  `₦${totalRev.toLocaleString('en-NG')}`],
    ];

    const boxW = PAGE_W / stats.length;
    stats.forEach(([label, val], i) => {
      const bx = MARGIN_L + i * boxW;
      doc.rect(bx, y, boxW - 4, 28).fillAndStroke('#F0F4FF', '#C7D7F5');
      doc.fillColor('#1E3A5F').fontSize(7).font('Helvetica').text(String(label), bx + 4, y + 4, { width: boxW - 10 });
      doc.fillColor('#0F2B4C').fontSize(11).font('Helvetica-Bold').text(String(val), bx + 4, y + 13, { width: boxW - 10 });
      doc.fillColor('#000000');
    });
  }

  // ── Column header row ────────────────────────────────────────────────────
  function drawColHeaders(y) {
    let x = MARGIN_L;
    doc.rect(MARGIN_L, y, tableWidth, COL_H_H).fill('#1E3A5F');
    COLS.forEach(([label, w]) => {
      doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold')
        .text(label, x + 3, y + 6, { width: w - 6, ellipsis: true });
      x += w;
    });
    doc.fillColor('#000000');
  }

  // ── Draw a single data row ────────────────────────────────────────────────
  const STATUS_FILL = {
    pending:           '#FEF3C7', confirmed: '#DBEAFE', 'picked-up': '#E0E7FF',
    in_progress:       '#F3E8FF', washing:   '#E0F2FE', ironing:     '#FCE7F3',
    ready:             '#D1FAE5', 'out-for-delivery': '#FEF9C3',
    delivered:         '#CFFAFE', completed: '#D1FAE5', cancelled:   '#FEE2E2',
  };

  function drawRow(order, rowY, even) {
    const bg = even ? '#FFFFFF' : '#F8FAFC';
    doc.rect(MARGIN_L, rowY, tableWidth, ROW_H).fill(bg);

    const cust = resolveCustomer(order);
    const p    = order.pricing || {};
    const total = p.total ?? order.total ?? 0;
    const cells = [
      order.orderNumber || '—',
      order.createdAt ? new Date(order.createdAt).toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' }) : '—',
      cust.name,
      cust.phone,
      order.status || '—',
      order.paymentStatus || '—',
      order.orderType || '—',
      formatItems(order),
      `₦${total.toLocaleString('en-NG')}`,
      order.assignedStaff?.name || 'Unassigned',
    ];

    let x = MARGIN_L;
    cells.forEach((text, i) => {
      const w = COLS[i][1];
      // Status cell gets colored background
      if (i === 4 && STATUS_FILL[order.status]) {
        doc.rect(x, rowY, w, ROW_H).fill(STATUS_FILL[order.status]);
      }
      doc.fillColor('#1A1A1A').fontSize(7).font('Helvetica')
        .text(String(text), x + 3, rowY + 6, { width: w - 6, ellipsis: true, lineBreak: false });
      // Column divider
      doc.moveTo(x + w, rowY).lineTo(x + w, rowY + ROW_H).strokeColor('#E2E8F0').lineWidth(0.5).stroke();
      x += w;
    });

    // Row bottom border
    doc.moveTo(MARGIN_L, rowY + ROW_H).lineTo(MARGIN_L + tableWidth, rowY + ROW_H)
      .strokeColor('#E2E8F0').lineWidth(0.5).stroke();
    doc.fillColor('#000000');
  }

  // ── Render ────────────────────────────────────────────────────────────────
  drawPageHeader();
  drawSummary();
  drawColHeaders(TABLE_TOP);

  let currentY = TABLE_TOP + COL_H_H;

  orders.forEach((order, idx) => {
    // New page if no room
    if (currentY + ROW_H > PAGE_H + 30) {
      doc.addPage();
      pageNum++;
      drawPageHeader();
      drawColHeaders(TABLE_TOP);
      currentY = TABLE_TOP + COL_H_H;
    }
    drawRow(order, currentY, idx % 2 === 0);
    currentY += ROW_H;
  });

  // ── Footer ────────────────────────────────────────────────────────────────
  doc.fontSize(7).fillColor('#888888')
    .text(`Generated by Relux Laundry Operations System · ${new Date().toLocaleString('en-NG')}`,
      MARGIN_L, doc.page.height - 20, { width: PAGE_W, align: 'center' });

  doc.end();
});
