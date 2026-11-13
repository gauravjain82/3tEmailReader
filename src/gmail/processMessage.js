const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { processPdf } = require('../services/invoiceProcessingService');
const { writeNamedFile, writeOriginal } = require('../storage/attachmentPaths');
const { senderAddress } = require('../config');
const { isZip, isPdf } = require('./attachmentTypes');
const { zipPdfs } = require('./zipPdfs');
const decode = s => Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64');
const safe = s => (s || 'attachment.pdf').replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,100);
const parts = part => [part, ...(part.parts || []).flatMap(parts)];
const header = (headers,name) => headers?.find(h => h.name?.toLowerCase() === name)?.value || '';
async function withRetry(call, sleep = ms => new Promise(resolve => setTimeout(resolve,ms))) {
  for (let attempt=0;;attempt++) {
    try { return await call(); }
    catch (e) {
      const code = Number(e.response?.status || e.code);
      const quota = (e.response?.data?.error?.errors || []).some(x => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(x.reason));
      if (attempt >= 3 || !(code === 429 || code >= 500 && code <= 599 || code === 403 && quota || ['ETIMEDOUT','ECONNRESET','EAI_AGAIN'].includes(e.code))) throw e;
      const headers = e.response?.headers;
      const retryAfter = headers?.get?.('retry-after') || headers?.['retry-after'];
      await sleep(Math.min(60000, Math.max(1000 * 2 ** attempt, (Number(retryAfter) || 0) * 1000)));
    }
  }
}
async function processMessage(api, id, store, dataDir, {allowedSenders,invoiceNumberFilenameSenders=[],reprocessCompleted=false,exportAfter=true,runId} = {}) {
  const response = await withRetry(() => api.users.messages.get({ userId:'me', id, format:'full' }));
  const m = response.data;
  const sender = header(m.payload?.headers,'from'), subject = header(m.payload?.headers,'subject');
  if (allowedSenders && !allowedSenders.includes(senderAddress(sender))) return {skippedSender:true,failed:false};
  const summary = {failed:false,duplicates:0};
  async function download(p) {
    let b64=p.body?.data;
    if (!b64) {
      if (!p.body?.attachmentId) throw Error('Attachment has no data');
      b64=(await withRetry(()=>api.users.messages.attachments.get({userId:'me',messageId:id,id:p.body.attachmentId}))).data.data;
    }
    if (!b64) throw Error('Empty attachment');
    return decode(b64);
  }
  async function handlePdf(p,index,zipKey) {
    // Gmail's download attachmentId may change between message fetches. MIME part identity is stable.
    let key = zipKey || `part-${p.partId ?? index}`;
    // Recognize pre-migration records by the original message/index filename prefix.
    // Never collapse attachments from different messages or different MIME parts by content hash alone.
    const prefix = `${safe(id)}-${index}-`;
    const legacy = store.db.prepare('SELECT * FROM invoices WHERE gmail_id=? ORDER BY id').all(id)
      .find(r => r.pdf_path && path.basename(r.pdf_path.replace(/\\+/g, path.sep)).startsWith(prefix));
    if (!zipKey && !store.find(id,key) && legacy) key = legacy.attachment_key;
    const existing = store.find(id,key);
    if (existing?.status === 'done' && !reprocessCompleted) return false;
    const name = p.filename || `attachment-${index}.pdf`;
    const old = store.db.prepare('SELECT * FROM invoices WHERE gmail_id=? AND attachment_key=?').get(id,key);
    const received = Number(m.internalDate);
    const meta = { gmail_id:id, attachment_key:key, attachment_source_id:p.body?.attachmentId || null, attachment_part_id:p.partId ?? String(index), sender, subject, filename:name, sha256:old?.sha256 || null, received_at:Number.isFinite(received) ? new Date(received).toISOString() : null };
    meta.source_run_id = runId || null;
    meta.archive_name = p.archiveName || null;
    meta.archive_entry = p.archiveEntry || null;
    try {
      let bytes;
      if (old?.pdf_path && fs.existsSync(old.pdf_path)) {
        bytes = fs.readFileSync(old.pdf_path);
        meta.pdf_path = old.pdf_path;
      } else {
        bytes = p.bytes || await download(p);
      }
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (meta.sha256 && hash !== meta.sha256) throw Error('Local PDF SHA-256 differs from original download');
      meta.sha256 = hash;
      const identity = zipKey ? '-'+crypto.createHash('sha256').update(zipKey).digest('hex').slice(0,16) : '';
      const base = `${safe(id)}-${index}${identity}-${hash.slice(0,12)}`;
      meta.json_path = path.join(dataDir, 'json', base + '.json');
      const result = await processPdf(bytes);
      const useInvoiceNumber = invoiceNumberFilenameSenders.includes(senderAddress(sender)) &&
        result.documentType === 'TAX_INVOICE' && result.invoiceNumber && result.validation.status !== 'FAILED';
      // Retain the email's original filename in metadata; only the saved PDF name changes.
      // Sanitize invoice references before treating them as a filename (e.g. INV/123).
      const downloadName = useInvoiceNumber ? result.invoiceNumber.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_') + '.pdf' : name;
      if(meta.pdf_path)writeOriginal(meta.pdf_path,bytes);
      else meta.pdf_path=writeNamedFile(path.resolve(dataDir,'pdfs'),downloadName,bytes);
      const saved = store.save(meta,result,{reprocess:reprocessCompleted});
      if (saved.is_duplicate) { summary.duplicates++; console.log('Duplicate invoice:',result.invoiceNumber,'original record:',saved.duplicate_of); }
      else console.log('Processed:', name, id, result.validation.status);
      if (result.validation.status === 'FAILED') { summary.failed=true; console.error('Extraction failed:', name, id, result.error); return true; }
    } catch (err) {
      summary.failed = true;
      if (meta.pdf_path) {
        store.save(meta, { documentType:'UNKNOWN', parserName:'download', parserVersion:require('../pdf/parserRegistry').PARSER_VERSION, lineItems:[], error:err.message, validation:{ status:'FAILED', issues:[{ field:'attachment',reason:err.message }],checks:[] } });
      } else store.markAttachment(meta,'failed',err.message);
      console.error('Failed:', name, id, err.message);
      return true;
    }
    return false;
  }
  for (const [index,p] of parts(m.payload || {}).entries()) {
    if (!isZip(p)) { if (isPdf(p)) await handlePdf(p,index); continue; }
    const key=`part-${p.partId ?? index}`;
    if (store.find(id,key)?.status === 'done' && !reprocessCompleted) continue;
    const meta={gmail_id:id,attachment_key:key,filename:p.filename || 'attachment.zip'};
    try {
      const bytes=await download(p);
      meta.sha256=crypto.createHash('sha256').update(bytes).digest('hex');
      let failed=false,count=0;
      for await (const entry of zipPdfs(bytes)) {
        const entryKey=key+':zip-'+entry.entryIndex+'-'+crypto.createHash('sha256').update(entry.entryName).digest('hex').slice(0,16);
        const child={...p,filename:entry.filename,bytes:entry.bytes,archiveName:meta.filename,archiveEntry:entry.entryName};
        if(await handlePdf(child,index,entryKey)) failed=true;
        count++;
      }
      store.markAttachment(meta,failed?'failed':'done',failed?'One or more ZIP PDFs failed':null);
      console.log('ZIP attachment:',meta.filename,'PDFs:',count);
    } catch(error) {
      summary.failed=true;
      store.markAttachment(meta,'failed',error.message);
      console.error('ZIP failed:',meta.filename,id,error.message);
    }
  }
  if (exportAfter) store.exportAll();
  return summary;
}
module.exports = { processMessage, withRetry, safe };
