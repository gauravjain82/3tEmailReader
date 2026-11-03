const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite } = require('../storage/store');

async function clearPreviousResults(store, dataDir) {
  const root = path.resolve(dataDir);
  const backupDir = path.join(root,'backups',`fresh-results-${Date.now()}-${crypto.randomUUID()}`);
  fs.mkdirSync(backupDir,{recursive:true});
  const backupPath = path.join(backupDir,'invoices.db');
  // Includes WAL transactions and is completed before moving files or clearing results.
  await store.db.backup(backupPath);
  const manifest = { createdAt:new Date().toISOString(), status:'prepared', database:backupPath,
    invoiceRecords:store.db.prepare('SELECT count(*) n FROM invoices').get().n,
    duplicateAttachments:store.db.prepare('SELECT count(*) n FROM duplicate_attachments').get().n,
    preserved:['pdfs','attachments','app_state','print_jobs','signature_checks'], archivedFiles:[] };
  const manifestPath = path.join(backupDir,'manifest.json');
  atomicWrite(manifestPath,JSON.stringify(manifest,null,2));
  const moved = [];
  try {
    for (const name of ['json','invoices.csv','duplicates.csv','failure-report.csv','signature-report.csv']) {
      const source = path.resolve(root,name), target = path.resolve(backupDir,name);
      // Only move these explicitly owned paths inside the active data directory and its backup.
      if (path.dirname(source) !== root || path.dirname(target) !== backupDir) throw Error('Result archive path is outside the data directory');
      if (!fs.existsSync(source)) continue;
      fs.renameSync(source,target);
      moved.push({source,target});
      manifest.archivedFiles.push(name);
    }
    store.db.transaction(()=>{
      store.db.exec(`DELETE FROM invoice_line_items;
        DELETE FROM extraction_runs;
        DELETE FROM duplicate_attachments;
        DELETE FROM invoice_numbers;
        UPDATE invoices SET duplicate_of=NULL;
        DELETE FROM invoices;`);
      // Preserve successful attachment tracking, checkpoints, and schema versions.
    }).immediate();
  } catch (error) {
    const recoveryErrors = [];
    for (const item of moved.reverse()) {
      try { fs.renameSync(item.target,item.source); } catch (e) { recoveryErrors.push(e.message); }
    }
    manifest.status = 'not-cleared'; manifest.error = error.message; manifest.recoveryErrors = recoveryErrors;
    atomicWrite(manifestPath,JSON.stringify(manifest,null,2));
    throw Error(`Previous results could not be cleared: ${error.message}. Backup: ${backupDir}`);
  }
  manifest.status = 'cleared';
  atomicWrite(manifestPath,JSON.stringify(manifest,null,2));
  fs.mkdirSync(path.join(root,'json'),{recursive:true});
  store.exportAll();
  console.log('Previous results archived:',backupDir);
  console.log('New results only. Original PDFs and the last-run checkpoint have been kept.');
  return {backupDir,clearedInvoices:manifest.invoiceRecords,clearedDuplicates:manifest.duplicateAttachments};
}
module.exports = { clearPreviousResults };
