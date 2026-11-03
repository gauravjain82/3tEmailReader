require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { gmail, root } = require('./common');
const { loadConfig } = require('./config');
const { openStore } = require('./storage/store');
const { runOnce, acquireRunLock } = require('./services/runOnceService');

async function start() {
  const config = loadConfig(root);
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
    return await runOnce({api:gmail(),store,dataDir,config,baseQuery:process.env.GMAIL_QUERY || 'in:inbox has:attachment filename:pdf',pageSize:process.env.PAGE_SIZE});
  } finally { if (store) store.close(); unlock(); }
}
if (require.main === module) start().catch(e=>{ console.error(e.message); process.exitCode=1; });
module.exports = { start };
