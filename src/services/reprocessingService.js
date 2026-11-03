const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { processPdf } = require('./invoiceProcessingService');
async function reprocess(store, { documentType, status, filename } = {}) {
  const rows = store.db.prepare('SELECT * FROM invoices ORDER BY id').all().filter(r => (!documentType || r.document_type === documentType) && (!status || r.validation_status === status) && (!filename || r.filename === filename));
  const summary = { processed: 0, statuses: {} };
  const cache = new Map();
  for (const row of rows) {
    if (!row.received_at && row.json_path && fs.existsSync(row.json_path)) {
      try {
        const original = JSON.parse(fs.readFileSync(row.json_path,'utf8'));
        if (original.gmailMessageId === row.gmail_id && original.receivedAt) row.received_at = original.receivedAt;
      } catch { /* Malformed legacy exports must not block local PDF recovery. */ }
    }
    let result;
    try {
      const bytes = fs.readFileSync(row.pdf_path);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (row.sha256 && hash !== row.sha256) throw Error('Local PDF SHA-256 differs from original download');
      const cacheKey = `${row.pdf_path}:${hash}`;
      if (!cache.has(cacheKey)) cache.set(cacheKey, await processPdf(bytes));
      result = cache.get(cacheKey);
    } catch (e) {
      result = { documentType: row.document_type || 'UNKNOWN', parserName: 'local-file', parserVersion: require('../pdf/parserRegistry').PARSER_VERSION, lineItems: [], error: e.message, validation: { status: 'FAILED', issues: [{ field: 'pdf', reason: e.message }], checks: [] } };
    }
    const saved = store.save(row, result, { reprocess: true });
    summary.processed++;
    summary.statuses[saved.validation_status] = (summary.statuses[saved.validation_status] || 0) + 1;
  }
  store.exportAll();
  return summary;
}
async function main() {
  require('dotenv').config();
  const { root } = require('../common');
  const { openStore } = require('../storage/store');
  const args = process.argv.slice(2), options = {};
  for (let i=0; i<args.length; i+=2) {
    const key = { '--document-type':'documentType', '--status':'status', '--filename':'filename' }[args[i]];
    if (!key || !args[i+1]) throw Error('Usage: npm run reprocess -- [--document-type TYPE] [--status STATUS] [--filename NAME]');
    options[key] = args[i+1];
  }
  if (options.documentType && !require('../pdf/detectDocumentType').TYPES.includes(options.documentType)) throw Error('Unknown document type');
  if (options.status && !['VALIDATED','NEEDS_REVIEW','FAILED','NOT_APPLICABLE'].includes(options.status)) throw Error('Unknown status');
  const dataDir = path.join(root,'data');
  // Online SQLite backup includes WAL transactions and occurs before migrations.
  if (fs.existsSync(path.join(dataDir,'invoices.db'))) {
    const Database = require('better-sqlite3');
    const original = new Database(path.join(dataDir,'invoices.db'));
    const backup = path.join(dataDir, 'backups', `invoices-${Date.now()}.db`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    try { await original.backup(backup); } finally { original.close(); }
    console.log('Database backup:', backup);
  }
  const store = openStore(dataDir);
  try { console.log(JSON.stringify(await reprocess(store, options), null, 2)); }
  finally { store.close(); }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { reprocess };
