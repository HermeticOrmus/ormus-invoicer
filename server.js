const express = require('express');
const Database = require('better-sqlite3');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8093;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'invoicer.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    company TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE NOT NULL,
    client_id INTEGER NOT NULL,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','paid','overdue','cancelled')),
    issue_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    notes TEXT,
    terms TEXT,
    subtotal REAL DEFAULT 0,
    tax_rate REAL DEFAULT 0,
    tax_amount REAL DEFAULT 0,
    total REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    paid_at TEXT,
    sent_at TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    quantity REAL DEFAULT 1,
    rate REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    client_id INTEGER,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','won','lost','archived')),
    share_token TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS deal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    entry_type TEXT DEFAULT 'note' CHECK(entry_type IN ('note','scope','pricing','decision','meeting')),
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS deal_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL,
    description TEXT NOT NULL,
    quantity REAL DEFAULT 1,
    rate REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    notes TEXT,
    sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE
  );
`);

// Seed default settings
const seedSettings = {
  company_name: 'Your Company',
  company_email: '',
  company_phone: '',
  company_address: '',
  bank_details: '',
  default_terms: 'Net 30. Payment due within 30 days of invoice date.',
  default_tax_rate: '0',
  invoice_prefix: 'ORX',
  next_invoice_seq: '1',
  currency: 'USD'
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(seedSettings)) {
  insertSetting.run(k, v);
}

// --- Helpers ---
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

function generateInvoiceNumber() {
  const prefix = getSetting('invoice_prefix') || 'ORX';
  const seq = parseInt(getSetting('next_invoice_seq') || '1', 10);
  const year = new Date().getFullYear();
  const num = String(seq).padStart(3, '0');
  setSetting('next_invoice_seq', String(seq + 1));
  return `${prefix}-${year}-${num}`;
}

function generateShareToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getDealWithDetails(id) {
  const deal = db.prepare(`
    SELECT d.*, c.name as client_name, c.company as client_company,
           c.email as client_email, c.address as client_address
    FROM deals d
    LEFT JOIN clients c ON d.client_id = c.id
    WHERE d.id = ?
  `).get(id);
  if (!deal) return null;
  deal.entries = db.prepare('SELECT * FROM deal_entries WHERE deal_id = ? ORDER BY sort_order, created_at').all(id);
  deal.items = db.prepare('SELECT * FROM deal_items WHERE deal_id = ? ORDER BY sort_order, id').all(id);
  deal.total = deal.items.reduce((sum, i) => sum + (i.amount || 0), 0);
  return deal;
}

function getDealByToken(token) {
  const deal = db.prepare(`
    SELECT d.*, c.name as client_name, c.company as client_company,
           c.email as client_email, c.address as client_address
    FROM deals d
    LEFT JOIN clients c ON d.client_id = c.id
    WHERE d.share_token = ?
  `).get(token);
  if (!deal) return null;
  deal.entries = db.prepare('SELECT * FROM deal_entries WHERE deal_id = ? ORDER BY sort_order, created_at').all(deal.id);
  deal.items = db.prepare('SELECT * FROM deal_items WHERE deal_id = ? ORDER BY sort_order, id').all(deal.id);
  deal.total = deal.items.reduce((sum, i) => sum + (i.amount || 0), 0);
  return deal;
}

function recalcInvoice(invoiceId) {
  const items = db.prepare('SELECT amount FROM invoice_items WHERE invoice_id = ?').all(invoiceId);
  const subtotal = items.reduce((sum, i) => sum + (i.amount || 0), 0);
  const invoice = db.prepare('SELECT tax_rate FROM invoices WHERE id = ?').get(invoiceId);
  const taxRate = invoice ? invoice.tax_rate : 0;
  const taxAmount = subtotal * (taxRate / 100);
  const total = subtotal + taxAmount;
  db.prepare('UPDATE invoices SET subtotal = ?, tax_amount = ?, total = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(subtotal, taxAmount, total, invoiceId);
  return { subtotal, taxAmount, total };
}

function getInvoiceWithItems(id) {
  const invoice = db.prepare(`
    SELECT i.*, c.name as client_name, c.company as client_company, c.email as client_email,
           c.phone as client_phone, c.address as client_address
    FROM invoices i
    JOIN clients c ON i.client_id = c.id
    WHERE i.id = ?
  `).get(id);
  if (!invoice) return null;
  invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id);
  return invoice;
}

// Identity from Cloudflare Access
function getIdentity(req) {
  return req.headers['cf-access-authenticated-user-email'] || 'local';
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// --- API Routes ---

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ormus-invoicer', timestamp: new Date().toISOString() });
});

// Settings
app.get('/api/settings', (req, res) => {
  res.json(getAllSettings());
});

app.put('/api/settings', (req, res) => {
  const allowed = ['company_name', 'company_email', 'company_phone', 'company_address',
    'bank_details', 'default_terms', 'default_tax_rate', 'invoice_prefix', 'currency'];
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) setSetting(k, v);
  }
  res.json(getAllSettings());
});

// Clients
app.get('/api/clients', (req, res) => {
  const clients = db.prepare(`
    SELECT c.*, COUNT(i.id) as invoice_count,
           COALESCE(SUM(CASE WHEN i.status != 'cancelled' THEN i.total ELSE 0 END), 0) as total_billed
    FROM clients c
    LEFT JOIN invoices i ON c.id = i.client_id
    GROUP BY c.id
    ORDER BY c.name
  `).all();
  res.json(clients);
});

app.get('/api/clients/:id', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

app.post('/api/clients', (req, res) => {
  const { name, company, email, phone, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const result = db.prepare(
    'INSERT INTO clients (name, company, email, phone, address, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, company || null, email || null, phone || null, address || null, notes || null);
  res.status(201).json({ id: result.lastInsertRowid, ...req.body });
});

app.put('/api/clients/:id', (req, res) => {
  const { name, company, email, phone, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  db.prepare(
    'UPDATE clients SET name=?, company=?, email=?, phone=?, address=?, notes=?, updated_at=datetime(\'now\') WHERE id=?'
  ).run(name, company || null, email || null, phone || null, address || null, notes || null, req.params.id);
  res.json({ id: parseInt(req.params.id), ...req.body });
});

app.delete('/api/clients/:id', (req, res) => {
  const invoices = db.prepare('SELECT COUNT(*) as count FROM invoices WHERE client_id = ?').get(req.params.id);
  if (invoices.count > 0) return res.status(400).json({ error: 'Cannot delete client with existing invoices' });
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// Invoices
app.get('/api/invoices', (req, res) => {
  const { status } = req.query;
  let query = `
    SELECT i.*, c.name as client_name, c.company as client_company
    FROM invoices i
    JOIN clients c ON i.client_id = c.id
  `;
  const params = [];
  if (status && status !== 'all') {
    query += ' WHERE i.status = ?';
    params.push(status);
  }
  query += ' ORDER BY i.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

app.get('/api/invoices/:id', (req, res) => {
  const invoice = getInvoiceWithItems(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  res.json(invoice);
});

app.post('/api/invoices', (req, res) => {
  const { client_id, issue_date, due_date, notes, terms, tax_rate, items, currency } = req.body;
  if (!client_id) return res.status(400).json({ error: 'Client is required' });

  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(client_id);
  if (!client) return res.status(400).json({ error: 'Client not found' });

  const invoiceNumber = generateInvoiceNumber();
  const settings = getAllSettings();
  const finalTerms = terms || settings.default_terms || '';
  const finalTaxRate = tax_rate != null ? parseFloat(tax_rate) : parseFloat(settings.default_tax_rate || '0');
  const finalCurrency = currency || settings.currency || 'USD';
  const today = new Date().toISOString().split('T')[0];

  const result = db.prepare(`
    INSERT INTO invoices (invoice_number, client_id, issue_date, due_date, notes, terms, tax_rate, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    invoiceNumber, client_id,
    issue_date || today,
    due_date || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
    notes || null, finalTerms, finalTaxRate, finalCurrency
  );

  const invoiceId = result.lastInsertRowid;

  // Insert items
  if (items && items.length > 0) {
    const insertItem = db.prepare(
      'INSERT INTO invoice_items (invoice_id, description, quantity, rate, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const qty = parseFloat(it.quantity) || 1;
      const rate = parseFloat(it.rate) || 0;
      insertItem.run(invoiceId, it.description || '', qty, rate, qty * rate, idx);
    }
  }

  recalcInvoice(invoiceId);
  res.status(201).json(getInvoiceWithItems(invoiceId));
});

app.put('/api/invoices/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Invoice not found' });
  if (existing.status === 'paid') return res.status(400).json({ error: 'Cannot edit a paid invoice' });

  const { client_id, issue_date, due_date, notes, terms, tax_rate, items, currency } = req.body;

  db.prepare(`
    UPDATE invoices SET client_id=COALESCE(?,client_id), issue_date=COALESCE(?,issue_date),
    due_date=COALESCE(?,due_date), notes=?, terms=COALESCE(?,terms),
    tax_rate=COALESCE(?,tax_rate), currency=COALESCE(?,currency), updated_at=datetime('now')
    WHERE id=?
  `).run(
    client_id || null, issue_date || null, due_date || null,
    notes !== undefined ? notes : existing.notes,
    terms || null, tax_rate != null ? parseFloat(tax_rate) : null,
    currency || null, req.params.id
  );

  // Replace items if provided
  if (items) {
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(req.params.id);
    const insertItem = db.prepare(
      'INSERT INTO invoice_items (invoice_id, description, quantity, rate, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx];
      const qty = parseFloat(it.quantity) || 1;
      const rate = parseFloat(it.rate) || 0;
      insertItem.run(req.params.id, it.description || '', qty, rate, qty * rate, idx);
    }
  }

  recalcInvoice(req.params.id);
  res.json(getInvoiceWithItems(req.params.id));
});

app.patch('/api/invoices/:id/status', (req, res) => {
  const { status } = req.body;
  const valid = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const extra = {};
  if (status === 'paid') extra.paid_at = new Date().toISOString();
  if (status === 'sent') extra.sent_at = new Date().toISOString();

  let sql = 'UPDATE invoices SET status = ?, updated_at = datetime(\'now\')';
  const params = [status];
  if (extra.paid_at) { sql += ', paid_at = ?'; params.push(extra.paid_at); }
  if (extra.sent_at) { sql += ', sent_at = ?'; params.push(extra.sent_at); }
  sql += ' WHERE id = ?';
  params.push(req.params.id);

  db.prepare(sql).run(...params);
  res.json(getInvoiceWithItems(req.params.id));
});

app.delete('/api/invoices/:id', (req, res) => {
  const existing = db.prepare('SELECT status FROM invoices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Invoice not found' });
  if (existing.status === 'paid') return res.status(400).json({ error: 'Cannot delete a paid invoice' });
  db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(req.params.id);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// Stats
app.get('/api/stats', (req, res) => {
  const total = db.prepare("SELECT COALESCE(SUM(total),0) as v FROM invoices WHERE status != 'cancelled'").get();
  const outstanding = db.prepare("SELECT COALESCE(SUM(total),0) as v FROM invoices WHERE status IN ('sent','overdue')").get();
  const paid = db.prepare("SELECT COALESCE(SUM(total),0) as v FROM invoices WHERE status = 'paid'").get();
  const overdue = db.prepare("SELECT COUNT(*) as v FROM invoices WHERE status = 'overdue'").get();
  const draft = db.prepare("SELECT COUNT(*) as v FROM invoices WHERE status = 'draft'").get();
  const counts = db.prepare("SELECT status, COUNT(*) as count FROM invoices GROUP BY status").all();

  res.json({
    total_billed: total.v,
    outstanding: outstanding.v,
    total_paid: paid.v,
    overdue_count: overdue.v,
    draft_count: draft.v,
    by_status: Object.fromEntries(counts.map(c => [c.status, c.count]))
  });
});

// PDF Generation
app.get('/api/invoices/:id/pdf', (req, res) => {
  const invoice = getInvoiceWithItems(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  const settings = getAllSettings();
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);
  doc.pipe(res);

  const gold = '#D29E3D';
  const dark = '#0B0B0D';
  const muted = '#555555';
  const pageW = doc.page.width - 100; // 50 margin each side

  // --- Header ---
  doc.fontSize(22).fillColor(dark).font('Helvetica-Bold')
    .text(settings.company_name || 'Your Company', 50, 50);

  let headerY = 75;
  doc.fontSize(9).font('Helvetica').fillColor(muted);
  if (settings.company_address) {
    const lines = settings.company_address.split('\n');
    for (const line of lines) {
      doc.text(line.trim(), 50, headerY);
      headerY += 13;
    }
  }
  if (settings.company_email) { doc.text(settings.company_email, 50, headerY); headerY += 13; }
  if (settings.company_phone) { doc.text(settings.company_phone, 50, headerY); headerY += 13; }

  // Invoice title — right side
  doc.fontSize(28).fillColor(gold).font('Helvetica-Bold')
    .text('INVOICE', 350, 50, { width: 195, align: 'right' });

  // Invoice meta — right side
  doc.fontSize(9).fillColor(dark).font('Helvetica');
  let metaY = 85;
  const metaX = 380;
  const metaLabelW = 80;
  const metaValW = 115;

  const metaRows = [
    ['Invoice #', invoice.invoice_number],
    ['Date', formatDate(invoice.issue_date)],
    ['Due Date', formatDate(invoice.due_date)],
    ['Status', invoice.status.toUpperCase()]
  ];
  for (const [label, val] of metaRows) {
    doc.font('Helvetica-Bold').text(label + ':', metaX, metaY, { width: metaLabelW });
    doc.font('Helvetica').text(val, metaX + metaLabelW, metaY, { width: metaValW, align: 'right' });
    metaY += 15;
  }

  // Gold divider
  const dividerY = Math.max(headerY, metaY) + 15;
  doc.moveTo(50, dividerY).lineTo(50 + pageW, dividerY).strokeColor(gold).lineWidth(2).stroke();

  // --- Bill To ---
  let billY = dividerY + 20;
  doc.fontSize(10).font('Helvetica-Bold').fillColor(gold).text('BILL TO', 50, billY);
  billY += 18;
  doc.fontSize(10).font('Helvetica-Bold').fillColor(dark).text(invoice.client_name, 50, billY);
  billY += 14;
  doc.font('Helvetica').fontSize(9).fillColor(muted);
  if (invoice.client_company) { doc.text(invoice.client_company, 50, billY); billY += 13; }
  if (invoice.client_address) {
    const lines = invoice.client_address.split('\n');
    for (const line of lines) { doc.text(line.trim(), 50, billY); billY += 13; }
  }
  if (invoice.client_email) { doc.text(invoice.client_email, 50, billY); billY += 13; }
  if (invoice.client_phone) { doc.text(invoice.client_phone, 50, billY); billY += 13; }

  // --- Items Table ---
  let tableY = billY + 25;

  // Table header
  const cols = [
    { label: 'Description', x: 50, w: 250 },
    { label: 'Qty', x: 310, w: 50, align: 'right' },
    { label: 'Rate', x: 370, w: 80, align: 'right' },
    { label: 'Amount', x: 460, w: 85, align: 'right' }
  ];

  doc.rect(50, tableY, pageW, 22).fill(dark);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#FFFFFF');
  for (const col of cols) {
    doc.text(col.label, col.x + 5, tableY + 6, { width: col.w - 10, align: col.align || 'left' });
  }
  tableY += 22;

  // Table rows
  doc.font('Helvetica').fontSize(9).fillColor(dark);
  for (let i = 0; i < invoice.items.length; i++) {
    const item = invoice.items[i];
    if (i % 2 === 0) {
      doc.rect(50, tableY, pageW, 22).fill('#F8F8F8');
    }
    doc.fillColor(dark);
    doc.text(item.description, 55, tableY + 6, { width: 240 });
    doc.text(formatNum(item.quantity), 315, tableY + 6, { width: 40, align: 'right' });
    doc.text(formatCurrency(item.rate, invoice.currency), 375, tableY + 6, { width: 70, align: 'right' });
    doc.text(formatCurrency(item.amount, invoice.currency), 465, tableY + 6, { width: 75, align: 'right' });
    tableY += 22;
  }

  // Thin line under table
  doc.moveTo(50, tableY).lineTo(50 + pageW, tableY).strokeColor('#DDDDDD').lineWidth(0.5).stroke();

  // Totals — right aligned
  tableY += 15;
  const totalsX = 370;
  const totalsValX = 460;
  const totalsW = 85;

  doc.font('Helvetica').fontSize(10).fillColor(muted);
  doc.text('Subtotal:', totalsX, tableY, { width: 80 });
  doc.text(formatCurrency(invoice.subtotal, invoice.currency), totalsValX, tableY, { width: totalsW, align: 'right' });
  tableY += 18;

  if (invoice.tax_rate > 0) {
    doc.text(`Tax (${invoice.tax_rate}%):`, totalsX, tableY, { width: 80 });
    doc.text(formatCurrency(invoice.tax_amount, invoice.currency), totalsValX, tableY, { width: totalsW, align: 'right' });
    tableY += 18;
  }

  // Total line
  doc.moveTo(totalsX, tableY).lineTo(totalsValX + totalsW, tableY).strokeColor(gold).lineWidth(1.5).stroke();
  tableY += 8;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(dark);
  doc.text('Total:', totalsX, tableY, { width: 80 });
  doc.text(formatCurrency(invoice.total, invoice.currency), totalsValX, tableY, { width: totalsW, align: 'right' });

  // --- Notes & Terms ---
  tableY += 40;
  if (invoice.notes) {
    doc.fontSize(10).font('Helvetica-Bold').fillColor(gold).text('Notes', 50, tableY);
    tableY += 16;
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(invoice.notes, 50, tableY, { width: pageW });
    tableY += doc.heightOfString(invoice.notes, { width: pageW }) + 15;
  }

  if (invoice.terms) {
    doc.fontSize(10).font('Helvetica-Bold').fillColor(gold).text('Payment Terms', 50, tableY);
    tableY += 16;
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(invoice.terms, 50, tableY, { width: pageW });
    tableY += doc.heightOfString(invoice.terms, { width: pageW }) + 15;
  }

  if (settings.bank_details) {
    doc.fontSize(10).font('Helvetica-Bold').fillColor(gold).text('Bank Details', 50, tableY);
    tableY += 16;
    doc.font('Helvetica').fontSize(9).fillColor(muted).text(settings.bank_details, 50, tableY, { width: pageW });
  }

  // --- Footer ---
  const footerY = doc.page.height - 40;
  doc.fontSize(7).fillColor(muted).font('Helvetica')
    .text(`${settings.company_name || 'Your Company'} — Generated ${new Date().toLocaleDateString('en-US')}`,
      50, footerY, { width: pageW, align: 'center' });

  doc.end();
});

// --- Deals ---
app.get('/api/deals', (req, res) => {
  const deals = db.prepare(`
    SELECT d.*, c.name as client_name, c.company as client_company,
           (SELECT COUNT(*) FROM deal_entries WHERE deal_id = d.id) as entry_count,
           (SELECT COUNT(*) FROM deal_items WHERE deal_id = d.id) as item_count,
           (SELECT COALESCE(SUM(amount), 0) FROM deal_items WHERE deal_id = d.id) as total
    FROM deals d
    LEFT JOIN clients c ON d.client_id = c.id
    ORDER BY d.updated_at DESC
  `).all();
  res.json(deals);
});

app.get('/api/deals/:id', (req, res) => {
  const deal = getDealWithDetails(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  res.json(deal);
});

app.post('/api/deals', (req, res) => {
  const { title, client_id } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const token = generateShareToken();
  const result = db.prepare(
    'INSERT INTO deals (title, client_id, share_token) VALUES (?, ?, ?)'
  ).run(title, client_id || null, token);
  res.status(201).json(getDealWithDetails(result.lastInsertRowid));
});

app.put('/api/deals/:id', (req, res) => {
  const { title, client_id, status } = req.body;
  db.prepare(`
    UPDATE deals SET title=COALESCE(?,title), client_id=?, status=COALESCE(?,status),
    updated_at=datetime('now') WHERE id=?
  `).run(title || null, client_id !== undefined ? client_id : null, status || null, req.params.id);
  res.json(getDealWithDetails(req.params.id));
});

app.delete('/api/deals/:id', (req, res) => {
  db.prepare('DELETE FROM deal_entries WHERE deal_id = ?').run(req.params.id);
  db.prepare('DELETE FROM deal_items WHERE deal_id = ?').run(req.params.id);
  db.prepare('DELETE FROM deals WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

app.post('/api/deals/:id/regenerate-token', (req, res) => {
  const token = generateShareToken();
  db.prepare('UPDATE deals SET share_token = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(token, req.params.id);
  res.json({ share_token: token });
});

// Deal entries
app.post('/api/deals/:id/entries', (req, res) => {
  const { title, content, entry_type } = req.body;
  if (!content) return res.status(400).json({ error: 'Content is required' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM deal_entries WHERE deal_id = ?')
    .get(req.params.id);
  const result = db.prepare(
    'INSERT INTO deal_entries (deal_id, title, content, entry_type, sort_order) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, title || null, content, entry_type || 'note', (maxOrder.m + 1));
  db.prepare('UPDATE deals SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
  const entry = db.prepare('SELECT * FROM deal_entries WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(entry);
});

app.put('/api/deals/:dealId/entries/:entryId', (req, res) => {
  const { title, content, entry_type } = req.body;
  db.prepare(`
    UPDATE deal_entries SET title=COALESCE(?,title), content=COALESCE(?,content),
    entry_type=COALESCE(?,entry_type), updated_at=datetime('now') WHERE id=? AND deal_id=?
  `).run(title || null, content || null, entry_type || null, req.params.entryId, req.params.dealId);
  db.prepare('UPDATE deals SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.dealId);
  const entry = db.prepare('SELECT * FROM deal_entries WHERE id = ?').get(req.params.entryId);
  res.json(entry);
});

app.delete('/api/deals/:dealId/entries/:entryId', (req, res) => {
  db.prepare('DELETE FROM deal_entries WHERE id = ? AND deal_id = ?').run(req.params.entryId, req.params.dealId);
  db.prepare('UPDATE deals SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.dealId);
  res.json({ deleted: true });
});

// Deal items
app.post('/api/deals/:id/items', (req, res) => {
  const { description, quantity, rate, notes } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required' });
  const qty = parseFloat(quantity) || 1;
  const r = parseFloat(rate) || 0;
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM deal_items WHERE deal_id = ?')
    .get(req.params.id);
  const result = db.prepare(
    'INSERT INTO deal_items (deal_id, description, quantity, rate, amount, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.id, description, qty, r, qty * r, notes || null, (maxOrder.m + 1));
  db.prepare('UPDATE deals SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);
  const item = db.prepare('SELECT * FROM deal_items WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(item);
});

app.put('/api/deals/:dealId/items/:itemId', (req, res) => {
  const { description, quantity, rate, notes } = req.body;
  const qty = parseFloat(quantity) || 1;
  const r = parseFloat(rate) || 0;
  db.prepare(`
    UPDATE deal_items SET description=COALESCE(?,description), quantity=?, rate=?, amount=?,
    notes=? WHERE id=? AND deal_id=?
  `).run(description || null, qty, r, qty * r, notes !== undefined ? notes : null,
    req.params.itemId, req.params.dealId);
  db.prepare('UPDATE deals SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.dealId);
  const item = db.prepare('SELECT * FROM deal_items WHERE id = ?').get(req.params.itemId);
  res.json(item);
});

app.delete('/api/deals/:dealId/items/:itemId', (req, res) => {
  db.prepare('DELETE FROM deal_items WHERE id = ? AND deal_id = ?').run(req.params.itemId, req.params.dealId);
  db.prepare('UPDATE deals SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.dealId);
  res.json({ deleted: true });
});

// Convert deal to invoice
app.post('/api/deals/:id/convert', (req, res) => {
  const deal = getDealWithDetails(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  if (!deal.client_id) return res.status(400).json({ error: 'Deal must have a client before converting' });
  if (deal.items.length === 0) return res.status(400).json({ error: 'Deal has no line items' });

  const invoiceNumber = generateInvoiceNumber();
  const settings = getAllSettings();
  const today = new Date().toISOString().split('T')[0];

  const result = db.prepare(`
    INSERT INTO invoices (invoice_number, client_id, issue_date, due_date, terms, tax_rate, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    invoiceNumber, deal.client_id, today,
    new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
    settings.default_terms || '', parseFloat(settings.default_tax_rate || '0'),
    settings.currency || 'USD'
  );

  const invoiceId = result.lastInsertRowid;
  const insertItem = db.prepare(
    'INSERT INTO invoice_items (invoice_id, description, quantity, rate, amount, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const item of deal.items) {
    insertItem.run(invoiceId, item.description, item.quantity, item.rate, item.amount, item.sort_order);
  }

  recalcInvoice(invoiceId);
  db.prepare("UPDATE deals SET status = 'won', updated_at = datetime('now') WHERE id = ?").run(deal.id);
  res.status(201).json(getInvoiceWithItems(invoiceId));
});

// --- Share Page (public, no auth) ---
app.get('/share/:token', (req, res) => {
  const deal = getDealByToken(req.params.token);
  if (!deal) return res.status(404).send('Not found');

  const settings = getAllSettings();
  const companyName = settings.company_name || 'Your Company';

  const escHtml = s => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmtCur = n => '$' + (n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const fmtDate = d => {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
  };

  // Simple markdown: headers, bold, italic, lists, code blocks, line breaks
  function renderMd(text) {
    if (!text) return '';
    let html = escHtml(text);
    // Code blocks
    html = html.replace(/```([\s\S]*?)```/g, '<pre style="background:#1a1a1f;padding:12px;border-radius:4px;overflow-x:auto;font-size:12px;margin:8px 0">$1</pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code style="background:#1a1a1f;padding:2px 5px;border-radius:3px;font-size:12px">$1</code>');
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4 style="color:#D29E3D;margin:16px 0 8px;font-size:14px">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 style="color:#D29E3D;margin:20px 0 10px;font-size:16px">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2 style="color:#D29E3D;margin:24px 0 12px;font-size:18px">$1</h2>');
    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li style="margin-left:20px;margin-bottom:4px">$1</li>');
    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li style="margin-left:20px;margin-bottom:4px;list-style:decimal">$1</li>');
    // Tables (basic: | col | col |)
    html = html.replace(/^\|(.+)\|$/gm, (match, inner) => {
      const cells = inner.split('|').map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) return ''; // separator row
      const tag = 'td';
      return '<tr>' + cells.map(c => `<${tag} style="padding:6px 10px;border-bottom:1px solid #222228">${c}</${tag}>`).join('') + '</tr>';
    });
    // Wrap consecutive table rows
    html = html.replace(/((<tr>.*<\/tr>\s*)+)/g, '<table style="width:100%;border-collapse:collapse;margin:8px 0;font-size:12px">$1</table>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    // Clean up double <br> after block elements
    html = html.replace(/(<\/h[234]>)<br>/g, '$1');
    html = html.replace(/(<\/pre>)<br>/g, '$1');
    html = html.replace(/(<\/table>)<br>/g, '$1');
    html = html.replace(/(<\/li>)<br>/g, '$1');
    return html;
  }

  const typeColors = {
    scope: '#3498db', pricing: '#D29E3D', decision: '#2ecc71',
    meeting: '#9b59b6', note: '#777'
  };

  const entriesHtml = deal.entries.map(e => `
    <div style="margin-bottom:24px;padding:20px;background:#111114;border:1px solid #1a1a1f;border-radius:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div>
          ${e.title ? '<h3 style="font-size:15px;font-weight:600;margin:0">' + escHtml(e.title) + '</h3>' : ''}
          <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${typeColors[e.entry_type] || '#777'}22;color:${typeColors[e.entry_type] || '#777'};text-transform:uppercase;letter-spacing:0.3px;font-weight:600">${escHtml(e.entry_type)}</span>
        </div>
        <span style="font-size:11px;color:#777">${fmtDate(e.created_at)}</span>
      </div>
      <div style="color:#ccc;line-height:1.7;font-size:13px">${renderMd(e.content)}</div>
    </div>
  `).join('');

  const itemsHtml = deal.items.length ? `
    <table style="width:100%;border-collapse:collapse;margin-top:16px">
      <thead>
        <tr style="background:#1a1a1f">
          <th style="text-align:left;padding:10px 14px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#777;font-weight:600">Description</th>
          <th style="text-align:right;padding:10px 14px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#777;font-weight:600">Qty</th>
          <th style="text-align:right;padding:10px 14px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#777;font-weight:600">Rate</th>
          <th style="text-align:right;padding:10px 14px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#777;font-weight:600">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${deal.items.map((it, i) => `
          <tr style="background:${i % 2 === 0 ? '#0B0B0D' : 'transparent'}">
            <td style="padding:10px 14px;border-bottom:1px solid #1a1a1f">
              ${escHtml(it.description)}
              ${it.notes ? '<div style="font-size:11px;color:#777;margin-top:4px">' + escHtml(it.notes) + '</div>' : ''}
            </td>
            <td style="padding:10px 14px;border-bottom:1px solid #1a1a1f;text-align:right">${it.quantity === Math.floor(it.quantity) ? Math.floor(it.quantity) : it.quantity.toFixed(2)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #1a1a1f;text-align:right">${fmtCur(it.rate)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #1a1a1f;text-align:right;font-weight:500">${fmtCur(it.amount)}</td>
          </tr>
        `).join('')}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="3" style="padding:12px 14px;text-align:right;font-weight:600;color:#D29E3D;font-size:15px">Total</td>
          <td style="padding:12px 14px;text-align:right;font-weight:600;color:#D29E3D;font-size:15px">${fmtCur(deal.total)}</td>
        </tr>
      </tfoot>
    </table>
  ` : '<p style="color:#777;text-align:center;padding:20px">No line items yet.</p>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(deal.title)} — ${escHtml(companyName)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#0B0B0D; color:#FAF6F0; font-size:13px; line-height:1.5; }
  .container { max-width:800px; margin:0 auto; padding:32px 24px; }
  a { color:#D29E3D; }
</style>
</head>
<body>
<div class="container">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #D29E3D">
    <div>
      <div style="font-size:12px;color:#D29E3D;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${escHtml(companyName)}</div>
      <h1 style="font-size:22px;font-weight:600">${escHtml(deal.title)}</h1>
      ${deal.client_name ? '<p style="color:#777;margin-top:4px">' + escHtml(deal.client_name) + (deal.client_company ? ' — ' + escHtml(deal.client_company) : '') + '</p>' : ''}
    </div>
    <div style="text-align:right">
      <span style="display:inline-block;padding:3px 10px;border-radius:10px;font-size:10px;font-weight:600;text-transform:uppercase;background:${deal.status==='active'?'rgba(210,158,61,0.15)':deal.status==='won'?'rgba(46,204,113,0.15)':'rgba(119,119,119,0.15)'};color:${deal.status==='active'?'#D29E3D':deal.status==='won'?'#2ecc71':'#777'}">${escHtml(deal.status)}</span>
      <div style="font-size:11px;color:#777;margin-top:6px">Updated ${fmtDate(deal.updated_at)}</div>
    </div>
  </div>

  ${deal.entries.length ? '<div style="margin-bottom:32px">' + entriesHtml + '</div>' : ''}

  ${deal.items.length ? '<div style="background:#111114;border:1px solid #1a1a1f;border-radius:6px;overflow:hidden;margin-bottom:32px"><div style="padding:12px 14px;border-bottom:1px solid #1a1a1f;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#D29E3D;font-weight:600">Line Items</div>' + itemsHtml + '</div>' : ''}

  <div style="text-align:center;padding:24px 0;color:#555;font-size:11px">
    ${escHtml(companyName)} — Confidential
  </div>
</div>
</body>
</html>`;

  res.type('html').send(html);
});

// --- Helpers ---
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatNum(n) {
  if (n === Math.floor(n)) return String(Math.floor(n));
  return n.toFixed(2);
}

function formatCurrency(amount, currency) {
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '\u20AC' : currency === 'PAB' ? 'B/.' : '$';
  return sym + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- Start ---
app.listen(PORT, () => {
  console.log(`ormus-invoicer running on http://localhost:${PORT}`);
});
