const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {PDFDocument} = require('pdf-lib');
const {PDFParse} = require('pdf-parse');
const {openStore} = require('../src/storage/store');
const {processText} = require('../src/services/invoiceProcessingService');
const {selectOriginalPages} = require('../src/pdf/originalPages');
const {saveOriginalInvoices} = require('../src/services/originalInvoiceService');
const {printOriginalInvoices,findSumatra} = require('../src/services/printService');
const {chooseInvoiceAction} = require('../src/services/invoiceOutputService');
const {runOnce} = require('../src/services/runOnceService');
const {clearPreviousResults} = require('../src/services/freshResultsService');
const mockSignatureValid=async()=>({status:'VALID',reason:'Mocked signature check for printer submission tests',checkedAt:new Date().toISOString(),signatures:[]});

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-original-test-'));
  const store=openStore(dir);
  t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-original-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store};
}
const page=(text,num=1)=>({text,num});
const text=label=>'Tax Invoice\nInvoice No: ORIG001\n'+label+'\nGoods supplied';
async function pdfBytes(labels) {
  const doc=await PDFDocument.create();
  for(const label of labels)doc.addPage().drawText(text(label),{x:30,y:700,size:12,lineHeight:20});
  return Buffer.from(await doc.save());
}
async function readPages(bytes) {const parser=new PDFParse({data:new Uint8Array(bytes)});try{return (await parser.getText()).pages;}finally{await parser.destroy();}}
async function seed(t,labels=['Original For Recipient','Duplicate For Transporter','Triplicate For Supplier']) {
  const f=fixture(t);const bytes=await pdfBytes(labels);
  const source=path.join(f.dir,'source.pdf');fs.writeFileSync(source,bytes);
  const meta={gmail_id:'m1',attachment_key:'part-1',sender:'billing@example.com',filename:'invoice.pdf',pdf_path:source,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),source_run_id:'test-run'};
  const doc=processText(text('Original For Recipient'));
  const row=f.store.save(meta,doc);
  return {...f,bytes,source,meta,doc,row,selection:{runId:'test-run',invoiceIds:[row.id]}};
}

test('selects recipient pages and continuation pages; excludes duplicate and extra copies',()=>{
  assert.deepEqual(selectOriginalPages([page(text('Original For Recipient')),page('Invoice continuation\nMore goods',2),page(text('Duplicate For Transporter'),3),page(text('Extra Copy'),4)],'ORIG001'),[0,1]);
  assert.deepEqual(selectOriginalPages([page(text('Original For Recipient')),page(text('Original For Recipient'),2)],'ORIG001'),[0]);
  assert.deepEqual(selectOriginalPages([page(text(''))],'ORIG001'),[0]);
});
test('ambiguous multi-page, duplicate-only, and multiple invoice PDFs are skipped',()=>{
  assert.throws(()=>selectOriginalPages([page(text('')),page('More goods')],'ORIG001'),/cannot be identified/);
  assert.throws(()=>selectOriginalPages([page(text('Duplicate For Transporter'))],'ORIG001'));
  assert.throws(()=>selectOriginalPages([page(text('Original For Recipient')),page('Tax Invoice\nInvoice No: DIFFERENT002\nOriginal For Recipient')],'ORIG001'),/different invoice number/);
});
test('copies only the original PDF page, retains source bytes and outputs each invoice once',async t=>{
  const {store,dir,source,bytes,selection,row}=await seed(t);
  const report=await saveOriginalInvoices(store,dir,{...selection,invoiceIds:[row.id,row.id]});
  assert.equal(report.invoices.length,1);assert.equal(report.skipped.length,0);assert.deepEqual(report.invoices[0].pages,[1]);
  const output=fs.readFileSync(report.invoices[0].pdfPath);assert.equal((await PDFDocument.load(output)).getPageCount(),1);
  const pages=await readPages(output);assert.match(pages[0].text,/Original For Recipient/);assert.doesNotMatch(pages[0].text,/Duplicate For|Triplicate For/);
  assert.deepEqual(fs.readFileSync(source),bytes);
  assert.equal((await saveOriginalInvoices(store,dir,{runId:'different-run',invoiceIds:[row.id]})).invoices.length,0);
});
test('source hash mismatch blocks saving or printing a changed download',async t=>{
  const {store,dir,source,selection}=await seed(t);fs.writeFileSync(source,'modified');
  const report=await saveOriginalInvoices(store,dir,selection);assert.equal(report.invoices.length,0);assert.match(report.skipped[0].reason,/SHA-256/);
});

test('saved originals retain the attachment filename in separate invoice folders',async t=>{
  const {store,dir,selection,meta}=await seed(t);
  store.db.prepare('UPDATE invoices SET filename=?').run('Original Invoice (41).pdf');
  const secondText=text('Original For Recipient').replace('ORIG001','ORIG002');
  const pdf=await PDFDocument.create();pdf.addPage().drawText(secondText,{x:30,y:700,size:12,lineHeight:20});
  const bytes=Buffer.from(await pdf.save());const source=path.join(dir,'second-source.pdf');fs.writeFileSync(source,bytes);
  const second=store.save({...meta,gmail_id:'m2',filename:'Original Invoice (41).pdf',pdf_path:source,sha256:crypto.createHash('sha256').update(bytes).digest('hex')},processText(secondText));
  const report=await saveOriginalInvoices(store,dir,{...selection,invoiceIds:[...selection.invoiceIds,second.id]});
  assert.equal(report.invoices.length,2);
  assert.equal(new Set(report.invoices.map(i=>i.pdfPath)).size,2);
  for(const invoice of report.invoices)assert.equal(path.basename(invoice.pdfPath),'Original Invoice (41).pdf');
});
test('printing submits only page one through the default printer and skips repeat attempts, including after fresh reset',async t=>{
  const {store,dir,selection}=await seed(t,['Original For Recipient','Continuation page','Duplicate For Transporter']);const report=await saveOriginalInvoices(store,dir,selection);const calls=[];
  assert.equal((await PDFDocument.load(fs.readFileSync(report.invoices[0].pdfPath))).getPageCount(),2);
  const options={platform:'win32',findExecutable:()=> 'C:\\SumatraPDF.exe',verifySignature:mockSignatureValid,run:async(...args)=>{calls.push(args);}};
  const result=await printOriginalInvoices(store,report.invoices,options);assert.equal(result.submitted.length,1);assert.equal(calls.length,1);
  assert.ok(calls[0][1].includes('-print-to-default'));assert.ok(calls[0][1].includes('1,1x,simplex,fit'));assert.equal(calls[0][2].windowsHide,true);assert.equal(calls[0][2].shell,undefined);
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).skipped.length,1);assert.equal(calls.length,1);
  await clearPreviousResults(store,dir);
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).skipped.length,1);assert.equal(calls.length,1);
});
test('uncertain printer results are recorded and not automatically printed again',async t=>{
  const {store,dir,selection}=await seed(t);const report=await saveOriginalInvoices(store,dir,selection);let calls=0;
  const options={platform:'win32',findExecutable:()=> 'C:\\SumatraPDF.exe',verifySignature:mockSignatureValid,run:async()=>{calls++;throw Error('Printer timed out');}};
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).uncertain.length,1);
  assert.equal(store.db.prepare('SELECT status FROM print_jobs').get().status,'uncertain');
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).skipped.length,1);assert.equal(calls,1);
});

test('Adobe prints the selected original page from unchanged complete bytes and preserves duplicate protection',async t=>{
  const {store,dir,selection,bytes}=await seed(t);
  const report=await saveOriginalInvoices(store,dir,selection);const calls=[];
  const options={platform:'win32',engine:'adobe',verifySignature:mockSignatureValid,findExecutable:()=>assert.fail('No Sumatra fallback'),run:()=>assert.fail('No Sumatra printing'),adobeSubmit:async job=>{
    calls.push(job);assert.equal(job.page,1);assert.deepEqual(fs.readFileSync(job.pdfPath),bytes);
  }};
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).submitted.length,1);
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).skipped.length,1);
  assert.equal(calls.length,1);
});

test('Adobe never prints a blocked signature and never retries an uncertain dialog submission',async t=>{
  const {store,dir,selection}=await seed(t);const report=await saveOriginalInvoices(store,dir,selection);
  const options={platform:'win32',engine:'adobe',verifySignature:async()=>({status:'UNKNOWN',reason:'Untrusted'}),adobeSubmit:()=>assert.fail('Blocked signatures cannot reach Reader')};
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).blocked.length,1);
  options.verifySignature=mockSignatureValid;
  options.adobeSubmit=async()=>{throw Object.assign(Error('Dialog unavailable'),{beforeSubmission:true});};
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).failed.length,1);
  options.adobeSubmit=async()=>{throw Object.assign(Error('Timeout after invocation'),{beforeSubmission:false});};
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).uncertain.length,1);
  options.adobeSubmit=()=>assert.fail('Uncertain submission must not retry');
  assert.equal((await printOriginalInvoices(store,report.invoices,options)).skipped.length,1);
});
test('missing printing utility does not reserve jobs; altered prepared PDFs are not submitted',async t=>{
  const {store,dir,selection}=await seed(t);const report=await saveOriginalInvoices(store,dir,selection);
  assert.throws(()=>findSumatra({}),/Install SumatraPDF/);
  await assert.rejects(printOriginalInvoices(store,report.invoices,{platform:'win32',verifySignature:mockSignatureValid,findExecutable:()=>{throw Error('Missing utility');}}),/Missing utility/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM print_jobs').get().n,0);
  fs.writeFileSync(report.invoices[0].pdfPath,'changed');
  const result=await printOriginalInvoices(store,report.invoices,{platform:'win32',findExecutable:()=> 'fake.exe',run:async()=>assert.fail('Must not print')});
  assert.equal(result.failed.length,1);
});
test('post-run action menu defaults to no printing and offers save, print and both',async()=>{
  assert.equal(await chooseInvoiceAction(0,{ask:async()=>assert.fail()}),'none');
  assert.equal(await chooseInvoiceAction(1,{interactive:false}),'none');
  for(const [answer,result] of [['','none'],['2','save'],['3','print'],['4','both']])assert.equal(await chooseInvoiceAction(1,{ask:async()=>answer}),result);
});
test('current batch selection survives an interrupted run and excludes historical or duplicate invoices',async t=>{
  const {dir,store}=fixture(t);const config={allowedSenders:['billing@example.com'],firstRunAfter:'1970-01-01T00:01:40Z'};
  const meta=id=>({gmail_id:id,attachment_key:'part-1',filename:'x.pdf'});
  store.save(meta('old'),processText('Tax Invoice\nInvoice No: OLD001'));
  let fail=true;let pendingRun;
  const handleMessage=async(api,id,s,d,options)=>{
    pendingRun=options.runId;
    if(!store.db.prepare("SELECT id FROM invoices WHERE gmail_id='new'").get())store.save({...meta('new'),source_run_id:options.runId},processText('Tax Invoice\nInvoice No: NEW002'));
    return {failed:fail};
  };
  const api={users:{messages:{list:async()=>({data:{messages:[{id:'new'}]}})}}};
  const opts={store,dataDir:dir,config,now:()=>200000,api,handleMessage};
  await assert.rejects(runOnce(opts),/checkpoint was not advanced/);const previousRun=pendingRun;fail=false;
  const summary=await runOnce(opts);assert.equal(summary.runId,previousRun);assert.equal(summary.invoiceIds.length,1);
  assert.equal(store.db.prepare('SELECT invoice_number FROM invoices WHERE id=?').get(summary.invoiceIds[0]).invoice_number,'NEW002');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'last-run-invoices.json'),'utf8')).invoiceIds,summary.invoiceIds);
});
test('actual FST, HUB and Astemo PDFs select only recipient pages',async t=>{
  const f=fixture(t);
  const dir=path.resolve(__dirname,'../data/pdfs');let available=0;
  for(const [suffix,number] of [['800450413.pdf','DS0003468303'],['23_12627110031_1.pdf','12627110031'],['6072.pdf','1326106072']]) {
    const file=fs.existsSync(dir) && fs.readdirSync(dir).find(f=>f.endsWith(suffix));if(!file)continue;
    available++;
    const source=path.join(dir,file),bytes=fs.readFileSync(source),pages=await readPages(bytes);
    assert.deepEqual(selectOriginalPages(pages,number),[0]);
    const row=f.store.save({gmail_id:file,attachment_key:'part-1',filename:suffix,pdf_path:source,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),source_run_id:'actual-samples'},processText(pages.map(p=>p.text).join('\n')));
    const report=await saveOriginalInvoices(f.store,f.dir,{runId:'actual-samples',invoiceIds:[row.id]});
    assert.equal(report.skipped.length,0,suffix);assert.equal(report.invoices.length,1,suffix);
    const exported=fs.readFileSync(report.invoices[0].pdfPath);
    if(report.invoices[0].signedOriginalPreserved)assert.deepEqual(exported,bytes);
    else assert.equal((await PDFDocument.load(exported)).getPageCount(),1);
    assert.deepEqual(fs.readFileSync(source),bytes);
  }
  if(!available)t.skip('Local invoice PDFs unavailable');
});
