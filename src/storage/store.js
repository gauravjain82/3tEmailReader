const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { invoiceIdentity } = require('./invoiceIdentity');
const { combineInvoiceParts } = require('./combineInvoiceParts');

const extraColumns = ['seller_name','seller_gstin','buyer_name','buyer_gstin','purchase_order_number','taxable_amount','cgst','sgst','igst','irn','document_type','validation_status','validation_json','parser_name','parser_version','reprocessed_at','received_at','attachment_source_id','attachment_part_id','normalized_invoice_number','source_run_id','structured_json'];
const fieldMap = { invoice_number:'invoiceNumber', invoice_date:'invoiceDate', vendor_code:'vendorCode', total_amount:'totalAmount', seller_name:'sellerName', seller_gstin:'sellerGstin', buyer_name:'buyerName', buyer_gstin:'buyerGstin', purchase_order_number:'purchaseOrderNumber', taxable_amount:'taxableAmount', cgst:'cgst', sgst:'sgst', igst:'igst', irn:'irn' };
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, value);
  fs.renameSync(temp, file);
}
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+@-]/.test(s)) s = "'" + s; // Avoid formulas when opened in spreadsheets.
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'invoices.db'));
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS attachments (id INTEGER PRIMARY KEY, gmail_id TEXT NOT NULL, attachment_key TEXT NOT NULL, filename TEXT, sha256 TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, processed_at TEXT, UNIQUE(gmail_id,attachment_key));
      CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY, gmail_id TEXT NOT NULL, attachment_key TEXT NOT NULL, sender TEXT, subject TEXT, filename TEXT, sha256 TEXT, invoice_number TEXT, invoice_date TEXT, vendor_code TEXT, gstins_json TEXT, part_numbers_json TEXT, total_amount TEXT, text_excerpt TEXT, json_path TEXT, pdf_path TEXT, processed_at TEXT NOT NULL, UNIQUE(gmail_id,attachment_key));`);
    const columns = new Set(db.prepare('PRAGMA table_info(invoices)').all().map(c => c.name));
    for (const col of extraColumns) if (!columns.has(col)) db.exec(`ALTER TABLE invoices ADD COLUMN ${col} TEXT`);
    if (!columns.has('duplicate_of')) db.exec('ALTER TABLE invoices ADD COLUMN duplicate_of INTEGER REFERENCES invoices(id)');
    db.exec(`CREATE TABLE IF NOT EXISTS invoice_line_items (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), line_index INTEGER NOT NULL, part_number TEXT, description TEXT, hsn_sac TEXT, quantity TEXT, unit_price TEXT, taxable_amount TEXT, cgst TEXT, sgst TEXT, igst TEXT, item_json TEXT NOT NULL, UNIQUE(invoice_id,line_index));
      CREATE TABLE IF NOT EXISTS extraction_runs (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), processed_at TEXT NOT NULL, parser_version TEXT, validation_status TEXT, result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS print_jobs (invoice_number TEXT PRIMARY KEY, status TEXT NOT NULL, pdf_path TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS signature_checks (invoice_number TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_pdf_path TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, checked_at TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(invoice_number,source_sha256));
      CREATE TABLE IF NOT EXISTS invoice_numbers (normalized_number TEXT PRIMARY KEY, invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id));
      CREATE INDEX IF NOT EXISTS invoices_number_idx ON invoices(normalized_invoice_number);
      CREATE TABLE IF NOT EXISTS duplicate_attachments (
        id INTEGER PRIMARY KEY, gmail_id TEXT NOT NULL, attachment_key TEXT NOT NULL, sender TEXT, subject TEXT, filename TEXT,
        sha256 TEXT, pdf_path TEXT, json_path TEXT NOT NULL, received_at TEXT, invoice_number TEXT NOT NULL,
        normalized_invoice_number TEXT NOT NULL, invoice_id INTEGER NOT NULL REFERENCES invoices(id), validation_status TEXT,
        result_json TEXT NOT NULL, detected_at TEXT NOT NULL, UNIQUE(gmail_id,attachment_key));
      INSERT OR IGNORE INTO schema_migrations VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=3').get()) {
      const update = db.prepare('UPDATE invoices SET normalized_invoice_number=? WHERE id=?');
      for (const row of db.prepare('SELECT id,invoice_number,document_type FROM invoices').all()) update.run(invoiceIdentity(row.invoice_number,row.document_type),row.id);
      for (const row of db.prepare('SELECT DISTINCT normalized_invoice_number number FROM invoices WHERE normalized_invoice_number IS NOT NULL').all()) syncIdentity(row.number);
      db.prepare('INSERT INTO schema_migrations VALUES (3,?)').run(new Date().toISOString());
    }
  }).immediate();
  function syncIdentity(number) {
    if (!number) return;
    const current = db.prepare('SELECT invoice_id FROM invoice_numbers WHERE normalized_number=?').get(number);
    const candidates = db.prepare("SELECT id FROM invoices WHERE normalized_invoice_number=? ORDER BY CASE validation_status WHEN 'VALIDATED' THEN 0 WHEN 'NEEDS_REVIEW' THEN 1 ELSE 2 END,id").all(number);
    const canonical = candidates.find(r=>r.id===current?.invoice_id) || candidates[0];
    if (!canonical) { db.prepare('DELETE FROM invoice_numbers WHERE normalized_number=?').run(number); return; }
    db.prepare('INSERT INTO invoice_numbers(normalized_number,invoice_id) VALUES (?,?) ON CONFLICT(normalized_number) DO UPDATE SET invoice_id=excluded.invoice_id').run(number,canonical.id);
    db.prepare('UPDATE invoices SET duplicate_of=CASE WHEN id=? THEN NULL ELSE ? END WHERE normalized_invoice_number=?').run(canonical.id,canonical.id,number);
    db.prepare('UPDATE duplicate_attachments SET invoice_id=? WHERE normalized_invoice_number=?').run(canonical.id,number);
  }
  function find(gmailId, key) { return db.prepare('SELECT * FROM attachments WHERE gmail_id=? AND attachment_key=?').get(gmailId, key); }
  function markAttachment(meta, status, error = null) {
    db.prepare(`INSERT INTO attachments (gmail_id,attachment_key,filename,sha256,status,attempts,error,processed_at)
      VALUES (@gmail_id,@attachment_key,@filename,@sha256,@status,1,@error,@processed_at)
      ON CONFLICT(gmail_id,attachment_key) DO UPDATE SET sha256=COALESCE(excluded.sha256,attachments.sha256),status=excluded.status,attempts=attachments.attempts+1,error=excluded.error,processed_at=excluded.processed_at`)
      .run({ ...meta, sha256: meta.sha256 || null, status, error, processed_at: new Date().toISOString() });
  }
  const saveTransaction = db.transaction((meta, result, { reprocess = false } = {}) => {
    const old = db.prepare('SELECT * FROM invoices WHERE gmail_id=? AND attachment_key=?').get(meta.gmail_id, meta.attachment_key);
    const now = new Date().toISOString();
    const doc = structuredClone(result);
    // Keep historical records and explicitly flag any retained values. A parser regression must not erase data.
    const retained = [];
    for (const [column, field] of Object.entries(fieldMap)) {
      if ((doc[field] == null || doc[field] === '') && old?.[column]) { doc[field] = old[column]; retained.push(field); }
    }
    for (const [column, field] of [['gstins_json','gstins'],['part_numbers_json','partNumbers']]) {
      if (!doc[field]?.length && old?.[column] && JSON.parse(old[column]).length) { doc[field] = JSON.parse(old[column]); retained.push(field); }
    }
    if (!doc.lineItems?.length && old) {
      const previous = db.prepare('SELECT item_json FROM invoice_line_items WHERE invoice_id=? ORDER BY line_index').all(old.id);
      if (previous.length) { doc.lineItems = previous.map(r => JSON.parse(r.item_json)); retained.push('lineItems'); }
    }
    if (retained.length) {
      doc.validation.issues.push({ field: 'retainedFields', reason: 'Previous values retained; current extraction did not supply them', fields: retained });
      if (doc.validation.status === 'VALIDATED') doc.validation.status = 'NEEDS_REVIEW';
    }
    const number = doc.validation.status === 'FAILED' && old ? old.normalized_invoice_number : invoiceIdentity(doc.invoiceNumber,doc.documentType);
    const claimed = number && db.prepare('SELECT invoice_id FROM invoice_numbers WHERE normalized_number=?').get(number);
    if (!old && claimed) {
      const jsonPath = meta.json_path || path.join(dataDir,'json',require('crypto').createHash('sha256').update(meta.gmail_id+':'+meta.attachment_key).digest('hex')+'.json');
      const duplicate = { gmailMessageId:meta.gmail_id, attachmentKey:meta.attachment_key, gmailAttachmentId:meta.attachment_source_id || null, attachmentPartId:meta.attachment_part_id || null, from:meta.sender || null, subject:meta.subject || null, filename:meta.filename || null, sha256:meta.sha256 || null, pdfPath:meta.pdf_path || null, receivedAt:meta.received_at || null, processedAt:now, ...doc, normalizedInvoiceNumber:number, isDuplicate:true, duplicateOf:claimed.invoice_id };
      const duplicateRow = { gmail_id:meta.gmail_id, attachment_key:meta.attachment_key, sender:meta.sender||null, subject:meta.subject||null, filename:meta.filename||null, sha256:meta.sha256||null, pdf_path:meta.pdf_path||null, json_path:jsonPath, received_at:meta.received_at||null, invoice_number:doc.invoiceNumber, normalized_invoice_number:number, invoice_id:claimed.invoice_id, validation_status:doc.validation.status, result_json:JSON.stringify(duplicate), detected_at:now };
      const cols=Object.keys(duplicateRow);
      db.prepare(`INSERT INTO duplicate_attachments (${cols.join(',')}) VALUES (${cols.map(c=>'@'+c).join(',')}) ON CONFLICT(gmail_id,attachment_key) DO UPDATE SET ${cols.filter(c=>!['gmail_id','attachment_key'].includes(c)).map(c=>`${c}=excluded.${c}`).join(',')}`).run(duplicateRow);
      markAttachment(meta,'done');
      return {id:claimed.invoice_id,duplicate_of:claimed.invoice_id,is_duplicate:true,validation_status:doc.validation.status};
    }
    const row = {};
    for (const col of ['gmail_id','attachment_key','sender','subject','filename','sha256','pdf_path','received_at','attachment_source_id','attachment_part_id','source_run_id']) row[col] = old?.[col] ?? meta[col] ?? null;
    if (old?.validation_status === 'FAILED' && meta.source_run_id) row.source_run_id = meta.source_run_id;
    row.processed_at = old?.processed_at || now;
    row.reprocessed_at = reprocess ? now : old?.reprocessed_at || null;
    row.json_path = old?.json_path || meta.json_path || path.join(dataDir, 'json', `${require('crypto').createHash('sha256').update(meta.gmail_id + ':' + meta.attachment_key).digest('hex')}.json`);
    if (old && db.prepare('SELECT 1 FROM invoices WHERE json_path=? AND id<>?').get(row.json_path, old.id)) {
      row.json_path = path.join(dataDir, 'json', `${require('crypto').createHash('sha256').update(meta.gmail_id + ':' + meta.attachment_key).digest('hex')}.json`);
    }
    for (const [column, field] of Object.entries(fieldMap)) row[column] = doc[field] ?? null;
    Object.assign(row, { gstins_json: JSON.stringify(doc.gstins || []), part_numbers_json: JSON.stringify(doc.partNumbers || []), text_excerpt: doc.textExcerpt || old?.text_excerpt || '', document_type: doc.documentType, validation_status: doc.validation.status, validation_json: JSON.stringify(doc.validation), parser_name: doc.parserName, parser_version: doc.parserVersion, normalized_invoice_number:number, duplicate_of:claimed && claimed.invoice_id !== old?.id ? claimed.invoice_id : null });
    const exported = { gmailMessageId: row.gmail_id, attachmentKey: row.attachment_key, gmailAttachmentId: row.attachment_source_id, attachmentPartId: row.attachment_part_id, from: row.sender, subject: row.subject, filename: row.filename, sha256: row.sha256, receivedAt: row.received_at, pdfPath: row.pdf_path, processedAt: row.processed_at, reprocessedAt: row.reprocessed_at, ...doc };
    row.structured_json = JSON.stringify(exported);
    if (old && !db.prepare('SELECT 1 FROM extraction_runs WHERE invoice_id=?').get(old.id)) db.prepare('INSERT INTO extraction_runs(invoice_id,processed_at,parser_version,validation_status,result_json) VALUES (?,?,?,?,?)').run(old.id, old.processed_at, old.parser_version || 'legacy', old.validation_status || 'UNREVIEWED', JSON.stringify(old));
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO invoices (${cols.join(',')}) VALUES (${cols.map(c => '@'+c).join(',')}) ON CONFLICT(gmail_id,attachment_key) DO UPDATE SET ${cols.filter(c => !['gmail_id','attachment_key'].includes(c)).map(c => `${c}=excluded.${c}`).join(',')}`).run(row);
    let invoice = db.prepare('SELECT * FROM invoices WHERE gmail_id=? AND attachment_key=?').get(meta.gmail_id,meta.attachment_key);
    if (old?.normalized_invoice_number !== number) {
      if (old?.normalized_invoice_number && old.duplicate_of == null) db.prepare('DELETE FROM invoice_numbers WHERE normalized_number=? AND invoice_id=?').run(old.normalized_invoice_number,old.id);
      syncIdentity(old?.normalized_invoice_number);
    }
    syncIdentity(number);
    invoice = db.prepare('SELECT * FROM invoices WHERE id=?').get(invoice.id);
    db.prepare('DELETE FROM invoice_line_items WHERE invoice_id=?').run(invoice.id);
    const itemInsert = db.prepare('INSERT INTO invoice_line_items(invoice_id,line_index,part_number,description,hsn_sac,quantity,unit_price,taxable_amount,cgst,sgst,igst,item_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    (doc.lineItems || []).forEach((i,index) => itemInsert.run(invoice.id,index,i.partNumber||null,i.description||null,i.hsnSac||null,i.quantity||null,i.unitPrice||null,i.taxableAmount||null,i.cgst??null,i.sgst??null,i.igst??null,JSON.stringify(i)));
    db.prepare('INSERT INTO extraction_runs(invoice_id,processed_at,parser_version,validation_status,result_json) VALUES (?,?,?,?,?)').run(invoice.id,now,doc.parserVersion,doc.validation.status,JSON.stringify({ candidate: result, saved: exported }));
    markAttachment(row, doc.validation.status === 'FAILED' ? 'failed' : 'done', doc.error || null);
    return {...invoice,is_duplicate:invoice.duplicate_of != null};
  });
  // Reserve the writer before reading: a deferred WAL transaction can otherwise
  // fail with SQLITE_BUSY_SNAPSHOT if another writer commits before our upsert.
  const save = (...args) => saveTransaction.immediate(...args);
  function exportAll() {
    const rows = db.prepare('SELECT * FROM invoices ORDER BY id').all();
    for (const row of rows) if (row.structured_json) atomicWrite(row.json_path, JSON.stringify({...JSON.parse(row.structured_json),normalizedInvoiceNumber:row.normalized_invoice_number,isDuplicate:row.duplicate_of != null,duplicateOf:row.duplicate_of}, null, 2));
    const duplicates = db.prepare('SELECT * FROM duplicate_attachments ORDER BY id').all();
    for (const row of duplicates) atomicWrite(row.json_path,JSON.stringify({...JSON.parse(row.result_json),duplicateOf:row.invoice_id},null,2));
    const cols=['invoice_number','invoice_date','part_number','quantity','taxable_amount','IRN No','email_subject'];
    const concise=[];
    for (const row of rows.filter(r=>r.duplicate_of==null && (r.document_type==='TAX_INVOICE' || !r.document_type))) {
      const items=combineInvoiceParts(db.prepare('SELECT part_number,quantity,taxable_amount FROM invoice_line_items WHERE invoice_id=? ORDER BY line_index').all(row.id));
      // Retain a header row for unparsed/legacy invoices; never invent item quantities or amounts.
      for (const item of items.length?items:[{}]) concise.push({invoice_number:row.invoice_number,invoice_date:row.invoice_date,part_number:item.part_number,quantity:item.quantity==null?'':String(item.quantity).replace(/(\.\d*?[1-9])0+$|\.0+$/,'$1'),taxable_amount:item.taxable_amount,'IRN No':row.irn,email_subject:row.subject});
    }
    atomicWrite(path.join(dataDir,'invoices.csv'),[cols.join(','),...concise.map(r=>cols.map(c=>csvCell(r[c])).join(','))].join('\r\n')+'\r\n');
    const duplicateColumns = ['gmail_id','attachment_key','sender','subject','filename','sha256','invoice_number','normalized_invoice_number','duplicate_of','validation_status','pdf_path','json_path','processed_at'];
    const duplicateRows = [...rows.filter(r=>r.duplicate_of != null),...duplicates.map(r=>({...r,duplicate_of:r.invoice_id,processed_at:r.detected_at}))];
    atomicWrite(path.join(dataDir,'duplicates.csv'),[duplicateColumns.join(','),...duplicateRows.map(r=>duplicateColumns.map(c=>csvCell(r[c])).join(','))].join('\r\n')+'\r\n');
    const failureColumns=['filename','invoice_number','status','reason','gmail_id','attachment_key','pdf_path','processed_at'];
    const failures=rows.filter(r=>r.duplicate_of==null && ['FAILED','NEEDS_REVIEW'].includes(r.validation_status)).map(r=>{
      let issues=[];
      try {issues=JSON.parse(r.validation_json || '{}').issues || [];} catch {issues=[{reason:'Validation details could not be read'}];}
      return {...r,status:r.validation_status,reason:issues.map(i=>`${i.field ? i.field+': ' : ''}${i.reason}`).join('; ')};
    });
    // Downloads can fail before an invoice row exists; include those attachments too.
    for (const row of db.prepare("SELECT a.* FROM attachments a LEFT JOIN invoices i ON i.gmail_id=a.gmail_id AND i.attachment_key=a.attachment_key WHERE a.status='failed' AND i.id IS NULL ORDER BY a.id").all()) failures.push({...row,status:'FAILED',invoice_number:null,pdf_path:null,reason:row.error || 'Attachment processing failed'});
    const checks=db.prepare('SELECT s.*,i.filename,i.gmail_id,i.attachment_key FROM signature_checks s JOIN invoices i ON i.normalized_invoice_number=s.invoice_number AND i.sha256=s.source_sha256 AND i.duplicate_of IS NULL ORDER BY i.id').all();
    atomicWrite(path.join(dataDir,'failure-report.csv'),[failureColumns.join(','),...failures.map(r=>failureColumns.map(c=>csvCell(r[c])).join(','))].join('\r\n')+'\r\n');
    const signatureColumns=['invoice_number','filename','status','reason','checked_at','source_pdf_path','source_sha256'];
    atomicWrite(path.join(dataDir,'signature-report.csv'),[signatureColumns.join(','),...checks.map(r=>signatureColumns.map(c=>csvCell(r[c])).join(','))].join('\r\n')+'\r\n');
    atomicWrite(path.join(dataDir,'signature-details.json'),JSON.stringify(checks.map(r=>({invoice_number:r.invoice_number,filename:r.filename,...JSON.parse(r.result_json)})),null,2));
  }
  return { db, find, save, markAttachment, exportAll, close: () => db.close() };
}
module.exports = { openStore, atomicWrite };
