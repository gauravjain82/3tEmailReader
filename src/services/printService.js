const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const execute = promisify(require('child_process').execFile);
const { verifyPdfSignature, recordSignatureCheck } = require('./signatureVerificationService');
const {submitAdobe}=require('./adobePrintService');
const {folderKey}=require('../storage/attachmentPaths');

function findSumatra(env=process.env) {
  const candidates=[env.SUMATRA_PDF,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA,'SumatraPDF','SumatraPDF.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles,'SumatraPDF','SumatraPDF.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'],'SumatraPDF','SumatraPDF.exe')].filter(Boolean);
  const executable=candidates.find(file=>path.isAbsolute(file) && /\.exe$/i.test(file) && fs.existsSync(file));
  if (!executable) throw Error('Install SumatraPDF on this PC, or set SUMATRA_PDF in .env to its full .exe path. Set the attached printer as the Windows default printer.');
  return executable;
}
async function printOriginalInvoices(store,invoices,{platform=process.platform,findExecutable=findSumatra,run=execute,verifySignature=verifyPdfSignature,engine=process.env.PRINT_ENGINE||'sumatra',adobeSubmit=submitAdobe,workDir=path.join(path.dirname(store.db.name),'print-work')}={}) {
  if (platform!=='win32') throw Error('Direct printing is supported on Windows PCs.');
  if(!['sumatra','adobe'].includes(engine))throw Error('PRINT_ENGINE must be sumatra or adobe');
  const result={engine,submitted:[],skipped:[],uncertain:[],failed:[],blocked:[],signatureChecks:[],unattempted:[]};
  const jobs=invoices.filter(item=>{
    const old=store.db.prepare('SELECT status FROM print_jobs WHERE invoice_number=?').get(item.invoiceNumber);
    if (old && old.status!=='failed') { result.skipped.push({invoiceNumber:item.invoiceNumber,reason:'Already submitted or needs printer-queue review'});return false; }
    return true;
  });
  if (!jobs.length) return result;
  let executable;
  fs.mkdirSync(workDir,{recursive:true});
  const adobeSessionFile=path.join(workDir,'adobe-session-'+crypto.randomUUID()+'.json');
  for (const [jobIndex,item] of jobs.entries()) {
    try {
      const bytes=fs.readFileSync(item.pdfPath);
      if (crypto.createHash('sha256').update(bytes).digest('hex')!==item.sha256) throw Error('Original-only PDF changed after preparation');
    } catch (e) { result.failed.push({invoiceNumber:item.invoiceNumber,reason:e.message});continue; }
    const signature=await verifySignature(item.sourcePdfPath || item.pdfPath,item.sourceSha256 || item.sha256);
    recordSignatureCheck(store,item,signature);
    result.signatureChecks.push({invoiceNumber:item.invoiceNumber,...signature});
    if (signature.status!=='VALID') {
      result.blocked.push({invoiceNumber:item.invoiceNumber,status:signature.status,reason:signature.reason});
      continue;
    }
    const sourcePdfPath=item.sourcePdfPath || item.pdfPath;
    const sourceHash=item.sourceSha256 || item.sha256;
    // Print a byte-identical copy of the verified complete original, not a rebuilt page PDF.
    const verifiedBytes=fs.readFileSync(sourcePdfPath);
    if (crypto.createHash('sha256').update(verifiedBytes).digest('hex')!==sourceHash) {result.failed.push({invoiceNumber:item.invoiceNumber,reason:'Original changed after signature verification'});continue;}
    const printPath=path.join(workDir,folderKey(item.invoiceNumber)+'-'+crypto.randomUUID()+'.pdf');
    fs.writeFileSync(printPath,verifiedBytes);
    const page=item.pages?.[0] || 1;
    if (!Number.isSafeInteger(page) || page<1) {result.failed.push({invoiceNumber:item.invoiceNumber,reason:'Invalid original print page'});continue;}
    if(engine==='sumatra')executable ||= findExecutable();
    const reserve=store.db.transaction(()=>{
      const old=store.db.prepare('SELECT status FROM print_jobs WHERE invoice_number=?').get(item.invoiceNumber);
      if (old && old.status!=='failed') return false;
      store.db.prepare(`INSERT INTO print_jobs(invoice_number,status,pdf_path,sha256,updated_at,error) VALUES (?,'submitting',?,?,?,NULL)
        ON CONFLICT(invoice_number) DO UPDATE SET status='submitting',pdf_path=excluded.pdf_path,sha256=excluded.sha256,updated_at=excluded.updated_at,error=NULL`)
        .run(item.invoiceNumber,printPath,sourceHash,new Date().toISOString());
      return true;
    }).immediate();
    if (!reserve) { result.skipped.push({invoiceNumber:item.invoiceNumber,reason:'Already submitted'});continue; }
    try {
      // First original-recipient page only, one copy, from the verified original bytes.
      // Pass arguments directly without a shell, including paths with spaces.
      if(engine==='adobe')await adobeSubmit({pdfPath:path.resolve(printPath),sha256:sourceHash,page,sessionFile:adobeSessionFile});
      else await run(executable,['-print-to-default','-print-settings',`${page},1x,simplex,fit`,'-silent',path.resolve(printPath)],{windowsHide:true,timeout:120000,maxBuffer:16384});
      store.db.prepare("UPDATE print_jobs SET status='submitted',updated_at=?,error=NULL WHERE invoice_number=?").run(new Date().toISOString(),item.invoiceNumber);
      result.submitted.push(item.invoiceNumber);
    } catch (e) {
      const status=e.beforeSubmission===true||['ENOENT','EACCES'].includes(e.code) ? 'failed' : 'uncertain';
      const reason=`Printer submission ${status}: ${e.message}`;
      store.db.prepare('UPDATE print_jobs SET status=?,updated_at=?,error=? WHERE invoice_number=?').run(status,new Date().toISOString(),reason,item.invoiceNumber);
      result[status].push({invoiceNumber:item.invoiceNumber,reason});
      if(engine==='adobe') {
        result.unattempted=jobs.slice(jobIndex+1).map(job=>({invoiceNumber:job.invoiceNumber,reason:'Adobe automation stopped after the previous failure; no submission attempted'}));
        break;
      }
    }
  }
  return result;
}
module.exports = { findSumatra, printOriginalInvoices };
