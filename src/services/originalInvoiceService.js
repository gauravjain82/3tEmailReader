const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFParse } = require('pdf-parse');
const { PDFDocument, PDFSignature } = require('pdf-lib');
const { selectOriginalPages } = require('../pdf/originalPages');
const { atomicWrite } = require('../storage/store');

async function saveOriginalInvoices(store,dataDir,{runId,invoiceIds}) {
  if (!/^[a-zA-Z0-9-]+$/.test(runId || '') || !Array.isArray(invoiceIds)) throw Error('Invalid current-run invoice selection');
  const outputDir=path.resolve(dataDir,'original-invoices',runId);
  const report={runId,outputDir,invoices:[],skipped:[]};
  const seen=new Set();
  for (const id of invoiceIds) {
    const row=Number.isSafeInteger(id) && store.db.prepare('SELECT * FROM invoices WHERE id=?').get(id);
    if (!row || row.source_run_id!==runId || row.duplicate_of!=null || row.document_type!=='TAX_INVOICE' || !row.normalized_invoice_number || !['VALIDATED','NEEDS_REVIEW'].includes(row.validation_status)) continue;
    if (seen.has(row.normalized_invoice_number)) continue;
    seen.add(row.normalized_invoice_number);
    try {
      const bytes=fs.readFileSync(row.pdf_path);
      const sourceHash=crypto.createHash('sha256').update(bytes).digest('hex');
      if (!row.sha256 || sourceHash!==row.sha256) throw Error('Source PDF does not match the original download SHA-256');
      const parser=new PDFParse({data:new Uint8Array(bytes)});
      let pages;
      try { pages=(await parser.getText()).pages; } finally { await parser.destroy(); }
      const indices=selectOriginalPages(pages,row.normalized_invoice_number);
      const source=await PDFDocument.load(bytes);
      if (source.getPageCount()!==pages.length) throw Error('PDF page count could not be verified');
      const signed=source.getForm().getFields().some(field=>field instanceof PDFSignature) || /\/ByteRange\s*\[/.test(bytes.toString('latin1'));
      let original=bytes;
      if (!signed && indices.length!==pages.length) {
        const target=await PDFDocument.create();
        const copied=await target.copyPages(source,indices);
        copied.forEach(p=>target.addPage(p));
        original=Buffer.from(await target.save());
      }
      const name=row.normalized_invoice_number.replace(/[^A-Z0-9._-]/g,'_')+'-'+sourceHash.slice(0,8)+'.pdf';
      const pdfPath=path.join(outputDir,name);
      atomicWrite(pdfPath,original);
      report.invoices.push({id:row.id,invoiceNumber:row.normalized_invoice_number,pdfPath,sha256:crypto.createHash('sha256').update(original).digest('hex'),sourcePdfPath:row.pdf_path,sourceSha256:sourceHash,pages:indices.map(n=>n+1),printPage:signed?indices[0]+1:1,signedOriginalPreserved:signed,validationStatus:row.validation_status});
    } catch (error) { report.skipped.push({id:row.id,invoiceNumber:row.normalized_invoice_number,reason:error.message}); }
  }
  atomicWrite(path.join(outputDir,'manifest.json'),JSON.stringify(report,null,2));
  return report;
}
module.exports = { saveOriginalInvoices };
