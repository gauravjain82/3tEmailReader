require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { gmail, root, gmailErrorMessage } = require('./common');
const { loadConfig, validateConfig } = require('./config');
const { openStore } = require('./storage/store');
const { runOnce, acquireRunLock, ensureCheckpoint } = require('./services/runOnceService');
const { chooseResultMode } = require('./services/resultModeService');
const { clearPreviousResults } = require('./services/freshResultsService');
const { chooseInvoiceAction, outputRunInvoices } = require('./services/invoiceOutputService');

async function start() {
  const config = loadConfig(root);
  const mode = await chooseResultMode(process.argv.slice(2));
  if (mode === 'cancel') { console.log('Cancelled. Previous results were kept.'); return; }
  const dataDir = path.join(root,'data');
  const unlock = acquireRunLock(dataDir);
  let store;
  try {
    // Back up before the first invoice-number migration, including WAL transactions.
    if (fs.existsSync(path.join(dataDir,'invoices.db'))) {
      const Database = require('better-sqlite3');
      const db = new Database(path.join(dataDir,'invoices.db'));
      try {
        const migrated = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoice_numbers'").get();
        if (!migrated) {
          const backup = path.join(dataDir,'backups',`before-invoice-dedup-${Date.now()}.db`);
          fs.mkdirSync(path.dirname(backup),{recursive:true});
          await db.backup(backup);
          console.log('Database backup:',backup);
        }
      } finally { db.close(); }
    }
    store = openStore(dataDir);
    const api = gmail();
    const baseQuery = process.env.GMAIL_QUERY || 'in:inbox has:attachment filename:pdf';
    if (mode === 'fresh') {
      // Establish the first-run boundary before clearing results; saved checkpoints stay intact.
      ensureCheckpoint(store,validateConfig(config),baseQuery,Math.floor(Date.now()/1000));
      await clearPreviousResults(store,dataDir);
    }
    const summary=await runOnce({api,store,dataDir,config,baseQuery,pageSize:process.env.PAGE_SIZE});
    if (summary.invoiceIds.length) {
      const action=await chooseInvoiceAction(summary.invoiceIds.length,{interactive:process.stdin.isTTY || process.argv.includes('--choose')});
      try { await outputRunInvoices(store,dataDir,summary,action); }
      catch (e) { console.error('Email processing completed. Save/print error:',e.message);console.error('Retry the last batch with npm run originals -- --save or --print.');process.exitCode=1; }
    } else console.log('No new unique invoices to save or print.');
    return summary;
  } finally { if (store) store.close(); unlock(); }
}
if (require.main === module) start().catch(e=>{ console.error(gmailErrorMessage(e)); process.exitCode=1; });
module.exports = { start };
