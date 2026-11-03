// Exercise migrations/reprocessing against a consistent SQLite backup, without changing live exports.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { openStore, atomicWrite } = require('../src/storage/store');
const { reprocess } = require('../src/services/reprocessingService');
const { processPdf } = require('../src/services/invoiceProcessingService');
const { root } = require('../src/common');

async function main() {
  const dataDir = path.join(root,'data');
  const outputDir = path.join(dataDir,'verification',String(Date.now()));
  fs.mkdirSync(outputDir,{recursive:true});
  const source = new Database(path.join(dataDir,'invoices.db'),{readonly:true});
  try { await source.backup(path.join(outputDir,'invoices.db')); } finally { source.close(); }
  const store = openStore(outputDir);
  try {
    const before = store.db.prepare('SELECT * FROM invoices ORDER BY id').all();
    const redirect = store.db.prepare('UPDATE invoices SET json_path=? WHERE id=?');
    store.db.transaction(() => before.forEach(r => {
      const jsonPath = path.join(outputDir,'json',r.id+'.json');
      if (r.json_path && fs.existsSync(r.json_path)) atomicWrite(jsonPath,fs.readFileSync(r.json_path));
      redirect.run(jsonPath,r.id);
    }))();
    const first = await reprocess(store);
    const second = await reprocess(store);
    const after = store.db.prepare('SELECT * FROM invoices ORDER BY id').all();
    assert.equal(after.length,before.length);
    for (let i=0;i<before.length;i++) {
      for (const field of ['id','gmail_id','attachment_key','sender','subject','filename','sha256','pdf_path','processed_at']) assert.equal(after[i][field],before[i][field],field);
    }
    assert.equal(store.db.pragma('integrity_check',{simple:true}),'ok');
    const documents = [];
    for (const pdfPath of [...new Set(before.map(r=>r.pdf_path))]) {
      const doc = await processPdf(pdfPath);
      const { textExcerpt, ...fields } = doc;
      documents.push({ filename:path.basename(pdfPath), ...fields });
    }
    const uniqueStatuses = {};
    for (const doc of documents) uniqueStatuses[doc.validation.status]=(uniqueStatuses[doc.validation.status]||0)+1;
    const report = { recordCount:before.length, uniquePdfs:documents.length, firstReprocessing:first, secondReprocessing:second, uniqueDocumentStatuses:uniqueStatuses, integrityCheck:'ok', preservedRecordIdsAndGmailMetadata:true, documents };
    atomicWrite(path.join(outputDir,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ outputDir, recordCount:before.length, uniquePdfs:documents.length, uniqueDocumentStatuses:uniqueStatuses, integrityCheck:'ok', reprocessingPreservedRecords:true },null,2));
  } finally { store.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode=1; });
