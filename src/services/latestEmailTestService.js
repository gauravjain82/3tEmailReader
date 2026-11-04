const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {validateConfig,senderAddress}=require('../config');
const {withRetry,processMessage}=require('../gmail/processMessage');
const {openStore,atomicWrite}=require('../storage/store');
const {saveOriginalInvoices}=require('./originalInvoiceService');
const {printOriginalInvoices}=require('./printService');
const {acquireRunLock}=require('./runLock');

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

async function testLatestEmails({api,projectRoot,config,log=console.log,print=false,choosePrint,printOptions={}}) {
  const {allowedSenders}=validateConfig(config);
  const outputDir=path.resolve(projectRoot,'data','test-runs',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID());
  // Never open the live database or invoke the normal run/checkpoint service.
  // Printing uses separate persistent test print history only when requested.
  const store=openStore(outputDir);
  const runId=crypto.randomUUID();
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
        const processing=await processMessage(api,message.id,store,outputDir,{allowedSenders:[sender],exportAfter:false,runId});
        entry.processing=processing;
        entry.status=processing.failed||processing.skippedSender?'FAILED':'PROCESSED';
      }catch(error){entry.status='FAILED';entry.error=error.message;log('Test email failed:',sender,error.message);}
      save();
    }
    const rows=store.db.prepare(`SELECT gmail_id,sender,subject,filename,pdf_path,sha256,normalized_invoice_number FROM invoices
      UNION ALL SELECT gmail_id,sender,subject,filename,pdf_path,sha256,normalized_invoice_number FROM duplicate_attachments`).all();
    for(const row of rows) {
      if(!row.pdf_path||!fs.existsSync(row.pdf_path))continue;
      const item={sender:row.sender,gmailId:row.gmail_id,subject:row.subject,filename:row.filename,invoiceNumber:row.normalized_invoice_number,pdfPath:row.pdf_path,sha256:row.sha256};
      report.attachments.push(item);
      save();
    }
    store.exportAll();
    const columns=['sender','email_subject','filename','invoice_number','pdf_path'];
    const lines=report.attachments.map(a=>[a.sender,a.subject,a.filename,a.invoiceNumber,a.pdfPath]);
    atomicWrite(path.join(outputDir,'attachments.csv'),'\uFEFF'+[columns,...lines].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n');
    const invoiceIds=store.db.prepare("SELECT id FROM invoices WHERE source_run_id=? AND duplicate_of IS NULL AND document_type='TAX_INVOICE' AND normalized_invoice_number IS NOT NULL AND validation_status IN ('VALIDATED','NEEDS_REVIEW') ORDER BY id").all(runId).map(row=>row.id);
    const printRequested=print===true||invoiceIds.length>0&&choosePrint&&await choosePrint(invoiceIds.length)===true;
    report.printRequested=Boolean(printRequested);
    if(printRequested&&invoiceIds.length) {
      try {
        const prepared=await saveOriginalInvoices(store,outputDir,{runId,invoiceIds,useDownloads:true});
        report.printPreparation=prepared.skipped;
        save();
        // Repeated tests must not resend successful or uncertain invoice jobs.
        // This ledger is independent of normal extraction and printing state.
        const historyDir=path.resolve(projectRoot,'data','test-runs','print-history');
        const release=acquireRunLock(historyDir);
        let history;
        try {
          history=openStore(historyDir);
          log('Printing unique test invoices through SumatraPDF on the Windows default printer.');
          report.printing=await printOriginalInvoices(history,prepared.invoices,{...printOptions,workDir:path.join(outputDir,'print-work')});
          report.printed=report.printing.submitted.length>0;
          store.exportAll();
          atomicWrite(path.join(outputDir,'print-result.json'),JSON.stringify(report.printing,null,2));
          log('SumatraPDF submissions:',report.printing.submitted.length,'already printed:',report.printing.skipped.length,'failed:',report.printing.failed.length,'uncertain:',report.printing.uncertain.length);
          for(const status of ['failed','uncertain'])for(const item of report.printing[status])log('Test print '+status+':',item.invoiceNumber,item.reason);
        }finally{if(history)history.close();release();}
      }catch(error){report.printError=error.message;report.printed=null;log('Test print error:',error.message,'Check the test print report and Windows printer queue before retrying.');}
    }
    if(printRequested&&!invoiceIds.length)log('No eligible unique invoices to print.');
    report.extractionsNeedingReview=store.db.prepare("SELECT count(*) n FROM invoices WHERE validation_status IN ('FAILED','NEEDS_REVIEW')").get().n;
    report.hasIssues=report.extractionsNeedingReview>0||report.emails.some(e=>e.status!=='PROCESSED')||Boolean(report.printError)||Boolean(report.printPreparation?.length)||['failed','uncertain'].some(key=>report.printing?.[key]?.length>0);
    report.completedAt=new Date().toISOString();save();
    log('Test invoices CSV:',path.join(outputDir,'invoices.csv'));
    log('Downloaded attachment report:',path.join(outputDir,'attachments.csv'));
    log('Main results and last-run checkpoint were not read or updated.');
    if(!report.printRequested)log('Nothing was printed.');
    return report;
  }finally{store.close();}
}
module.exports={latestPdfEmail,testLatestEmails};
