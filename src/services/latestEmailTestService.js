const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {validateConfig,senderAddress}=require('../config');
const {withRetry,processMessage}=require('../gmail/processMessage');
const {openStore,atomicWrite}=require('../storage/store');
const {verifyPdfSignature,recordSignatureCheck}=require('./signatureVerificationService');

const header=(m,name)=>m.payload?.headers?.find(h=>h.name?.toLowerCase()===name)?.value||'';
const parts=p=>[p,...(p.parts||[]).flatMap(parts)];
const hasPdf=m=>parts(m.payload||{}).some(p=>p.mimeType==='application/pdf'||/\.pdf$/i.test(p.filename||''));

async function latestPdfEmail(api,sender) {
  const candidates=[];
  const seen=new Set(),tokens=new Set();
  let pageToken;
  do {
    // No saved time window, firstRunAfter or last-run checkpoint is consulted.
    const {data:page}=await withRetry(()=>api.users.messages.list({userId:'me',q:`from:${sender} has:attachment filename:pdf`,maxResults:100,pageToken}));
    const ids=(page.messages||[]).map(m=>m.id).filter(id=>{if(seen.has(id))return false;seen.add(id);return true;});
    // Compare Gmail's received times instead of relying on list ordering. Limit
    // concurrent metadata reads to five to avoid bursts against the user's quota.
    for(let start=0;start<ids.length;start+=5) {
      const results=await Promise.allSettled(ids.slice(start,start+5).map(async id=>{
        const {data:m}=await withRetry(()=>api.users.messages.get({userId:'me',id,format:'metadata',metadataHeaders:['From','Subject']}));
        return {...m,id};
      }));
      for(const result of results) {
        if(result.status==='rejected')throw result.reason;
        const m=result.value;
        if(senderAddress(header(m,'from'))!==sender)continue;
        if(!Number.isFinite(Number(m.internalDate)))throw Error('Gmail message has no valid received time');
        candidates.push(m);
      }
    }
    pageToken=page.nextPageToken;
    if(pageToken&&tokens.has(pageToken))throw Error('Gmail returned a repeated pagination token');
    if(pageToken)tokens.add(pageToken);
  }while(pageToken);
  candidates.sort((a,b)=>Number(b.internalDate)-Number(a.internalDate)||b.id.localeCompare(a.id));
  for(const candidate of candidates) {
    const {data:m}=await withRetry(()=>api.users.messages.get({userId:'me',id:candidate.id,format:'full'}));
    if(senderAddress(header(m,'from'))===sender&&hasPdf(m))return {...m,id:candidate.id};
  }
  return null;
}

function csvCell(value) {
  let text=String(value??'');
  if(/^[=+@-]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}

async function testLatestEmails({api,projectRoot,config,verifySignature=verifyPdfSignature,log=console.log}) {
  const {allowedSenders}=validateConfig(config);
  const outputDir=path.resolve(projectRoot,'data','test-runs',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID());
  // This is the only database opened by this command. Never call runOnce,
  // outputRunInvoices or any print service, and never open the live database.
  const store=openStore(outputDir);
  const report={outputDir,startedAt:new Date().toISOString(),checkpointChanged:false,mainResultsChanged:false,printed:false,emails:[],attachments:[]};
  const save=()=>atomicWrite(path.join(outputDir,'test-report.json'),JSON.stringify(report,null,2));
  log('Isolated email test output:',outputDir);save();
  try {
    for(const sender of allowedSenders) {
      const entry={sender,status:'SEARCHING'};report.emails.push(entry);save();
      try {
        log('Finding latest PDF email from:',sender);
        const message=await latestPdfEmail(api,sender);
        if(!message){entry.status='NO_MATCH';log('No PDF email found:',sender);save();continue;}
        Object.assign(entry,{gmailId:message.id,subject:header(message,'subject'),receivedAt:new Date(Number(message.internalDate)).toISOString(),status:'PROCESSING'});save();
        log('Selected:',entry.subject,'received',entry.receivedAt);
        const processing=await processMessage(api,message.id,store,outputDir,{allowedSenders:[sender],exportAfter:false,runId:crypto.randomUUID()});
        entry.processing=processing;
        entry.status=processing.failed||processing.skippedSender?'FAILED':'PROCESSED';
      }catch(error){entry.status='FAILED';entry.error=error.message;log('Test email failed:',sender,error.message);}
      save();
    }
    const rows=store.db.prepare(`SELECT gmail_id,sender,subject,filename,pdf_path,sha256,normalized_invoice_number FROM invoices
      UNION ALL SELECT gmail_id,sender,subject,filename,pdf_path,sha256,normalized_invoice_number FROM duplicate_attachments`).all();
    for(const row of rows) {
      if(!row.pdf_path||!fs.existsSync(row.pdf_path))continue;
      let signature;
      try{signature=await verifySignature(row.pdf_path,row.sha256);}catch(error){signature={status:'ERROR',reason:error.message,signatures:[]};}
      const item={sender:row.sender,gmailId:row.gmail_id,subject:row.subject,filename:row.filename,invoiceNumber:row.normalized_invoice_number,pdfPath:row.pdf_path,sha256:row.sha256,signature};
      report.attachments.push(item);
      if(row.normalized_invoice_number)recordSignatureCheck(store,{invoiceNumber:row.normalized_invoice_number,sourcePdfPath:row.pdf_path,sourceSha256:row.sha256},signature);
      log('Signature:',row.filename,signature.status);save();
    }
    store.exportAll();
    const columns=['sender','email_subject','filename','invoice_number','signature_status','reason','pdf_path'];
    const lines=report.attachments.map(a=>[a.sender,a.subject,a.filename,a.invoiceNumber,a.signature.status,a.signature.reason,a.pdfPath]);
    atomicWrite(path.join(outputDir,'attachment-signatures.csv'),'\uFEFF'+[columns,...lines].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n');
    report.extractionsNeedingReview=store.db.prepare("SELECT count(*) n FROM invoices WHERE validation_status IN ('FAILED','NEEDS_REVIEW')").get().n;
    report.hasIssues=report.extractionsNeedingReview>0||report.emails.some(e=>e.status!=='PROCESSED')||report.attachments.some(a=>a.signature.status!=='VALID');
    report.completedAt=new Date().toISOString();save();
    log('Test invoices CSV:',path.join(outputDir,'invoices.csv'));
    log('All-attachment signature report:',path.join(outputDir,'attachment-signatures.csv'));
    log('Main results and last-run checkpoint were not read or updated. Nothing was printed.');
    return report;
  }finally{store.close();}
}
module.exports={latestPdfEmail,testLatestEmails};
