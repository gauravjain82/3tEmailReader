const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const {zipFixture}=require('./helpers/zipFixture');
const {zipPdfs,ZIP_LIMITS}=require('../src/gmail/zipPdfs');
const {isSupportedAttachment,includeZipAttachments,DEFAULT_GMAIL_QUERY}=require('../src/gmail/attachmentTypes');
const {processMessage}=require('../src/gmail/processMessage');
const {openStore}=require('../src/storage/store');
const {runOnce,checkpointKey,buildQuery}=require('../src/services/runOnceService');
const {latestPdfEmail,testLatestEmails}=require('../src/services/latestEmailTestService');
const collect=async(bytes,limits)=>{const rows=[];for await(const row of zipPdfs(bytes,limits))rows.push(row);return rows;};
async function pdf(number){const doc=await PDFDocument.create();const font=await doc.embedFont(StandardFonts.Helvetica);doc.addPage().drawText(`Tax Invoice\nInvoice No: ${number}\nE-Way Bill No: 372375307838`,{font,size:12,x:20,y:700});return Buffer.from(await doc.save());}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-zip-'));const store=openStore(dir);t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-zip-'));fs.rmSync(dir,{recursive:true,force:true});});return {dir,store};}
const cfg={allowedSenders:['billing@example.com'],firstRunAfter:'1970-01-01T00:01:40Z'};
function message(){return {id:'m',internalDate:'150000',payload:{headers:[{name:'From',value:'billing@example.com'}],parts:[]}};}

test('ZIP folders and upper-case PDF names are read without changing PDF bytes',async()=>{
  const data=await pdf('ZIP001');const bytes=zipFixture([{name:'folder/'},{name:'folder/invoice.PDF',data},{name:'readme.txt',data:'ignored'},{name:'nested.zip',data:'not opened'}]);
  const rows=await collect(bytes);assert.equal(rows.length,1);assert.equal(rows[0].filename,'invoice.PDF');assert.equal(rows[0].entryName,'folder/invoice.PDF');assert.deepEqual(rows[0].bytes,data);
});

test('bad, encrypted, unsafe and oversized ZIP entries fail with a reason',async()=>{
  await assert.rejects(collect(Buffer.from('not a zip')));
  for(const entry of [{name:'../escape.pdf',data:'pdf'},{name:'bad.pdf',data:'pdf',badCrc:true},{name:'locked.pdf',data:'pdf',encrypted:true},{name:'size.pdf',data:'pdf',size:1}])await assert.rejects(collect(zipFixture([entry])));
  const bytes=zipFixture([{name:'one.pdf',data:'12345'},{name:'two.pdf',data:'12345'}]);
  for(const patch of [{archiveBytes:1},{pdfBytes:4},{totalBytes:9},{entries:1},{pdfs:1}])await assert.rejects(collect(bytes,{...ZIP_LIMITS,...patch}));
});

test('mixed PDF/ZIP email retains archive provenance and stable per-entry duplicate tracking',async t=>{
  const {dir,store}=fixture(t),one=await pdf('ZIP001'),two=await pdf('ZIP002');
  const zipped=zipFixture([{name:'a/invoice.pdf',data:one},{name:'b/invoice.pdf',data:two},{name:'copy/invoice.pdf',data:one},{name:'a/invoice.pdf',data:one}]);
  const msg=message();msg.payload.parts=[{partId:'1',mimeType:'application/pdf',filename:'direct.pdf',body:{data:one.toString('base64url')}},{partId:'2',mimeType:'application/octet-stream',filename:'Invoices.ZIP',body:{attachmentId:'rotating-1'}}];
  let downloads=0;const api={users:{messages:{get:async()=>({data:msg}),attachments:{get:async()=>{downloads++;return {data:{data:zipped.toString('base64url')}};}}}}};
  const options={...cfg,runId:'zip-run'};const first=await processMessage(api,'m',store,dir,options);assert.equal(first.failed,false);assert.equal(first.duplicates,3);
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,2);assert.equal(store.db.prepare('SELECT count(*) n FROM duplicate_attachments').get().n,3);
  const row=store.db.prepare('SELECT * FROM invoices WHERE invoice_number=?').get('ZIP002');assert.equal(row.archive_name,'Invoices.ZIP');assert.equal(row.archive_entry,'b/invoice.pdf');assert.equal(row.eway_bill_number,'372375307838');assert.equal(row.source_run_id,'zip-run');assert.deepEqual(fs.readFileSync(row.pdf_path),two);
  const exported=JSON.parse(fs.readFileSync(row.json_path));assert.equal(exported.archiveEntry,'b/invoice.pdf');
  const paths=store.db.prepare('SELECT json_path FROM invoices UNION ALL SELECT json_path FROM duplicate_attachments').all().map(r=>r.json_path);assert.equal(new Set(paths).size,5);
  msg.payload.parts[1].body.attachmentId='rotating-2';await processMessage(api,'m',store,dir,options);assert.equal(downloads,1);
  await processMessage(api,'m',store,dir,{...options,reprocessCompleted:true});assert.equal(downloads,2);assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,2);
});

test('corrupt ZIP leaves checkpoint unchanged and retries without repeating completed PDFs',async t=>{
  const {dir,store}=fixture(t),one=await pdf('DIRECT001'),two=await pdf('ZIP002');const msg=message();let bytes=Buffer.from('broken ZIP');
  msg.payload.parts=[{partId:'1',mimeType:'application/pdf',filename:'direct.pdf',body:{data:one.toString('base64url')}},{partId:'2',mimeType:'application/zip',filename:'invoices.zip',body:{attachmentId:'zip'}}];
  const api={users:{messages:{list:async()=>({data:{messages:[{id:'m'}]}}),get:async()=>({data:msg}),attachments:{get:async()=>({data:{data:bytes.toString('base64url')}})}}}};
  const opts={api,store,dataDir:dir,config:cfg,now:()=>200000};await assert.rejects(runOnce(opts),/checkpoint was not advanced/);
  assert.equal(JSON.parse(store.db.prepare('SELECT value FROM app_state WHERE key=?').get(checkpointKey(cfg,DEFAULT_GMAIL_QUERY)).value).since,100);
  assert.match(fs.readFileSync(path.join(dir,'failure-report.csv'),'utf8'),/invoices.zip/);
  bytes=zipFixture([{name:'invoice.pdf',data:two}]);await runOnce(opts);
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,2);assert.equal(store.db.prepare('SELECT count(*) n FROM extraction_runs').get().n,2);
});

test('partial ZIP failure retains completed entries and retries the remaining entry',async t=>{
  const {dir,store}=fixture(t),one=await pdf('ZIP001'),two=await pdf('ZIP002');
  const msg=message();let bytes=zipFixture([{name:'one.pdf',data:one},{name:'two.pdf',data:two,badCrc:true}]);
  msg.payload.parts=[{partId:'zip',filename:'invoices.zip',body:{attachmentId:'archive'}}];
  const api={users:{messages:{get:async()=>({data:msg}),attachments:{get:async()=>({data:{data:bytes.toString('base64url')}})}}}};
  assert.equal((await processMessage(api,'m',store,dir,cfg)).failed,true);
  assert.equal(store.find('m','part-zip').status,'failed');
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  bytes=zipFixture([{name:'one.pdf',data:one},{name:'two.pdf',data:two}]);
  assert.equal((await processMessage(api,'m',store,dir,cfg)).failed,false);
  assert.equal(store.find('m','part-zip').status,'done');
  assert.equal(store.db.prepare('SELECT count(*) n FROM extraction_runs').get().n,2);
});

test('latest-email test parses an inline ZIP in isolation',async t=>{
  const {dir,store}=fixture(t),data=await pdf('ZIP001');const msg=message();
  msg.payload.parts=[{partId:'1',mimeType:'application/x-zip-compressed',filename:'invoices.zip',body:{data:zipFixture([{name:'invoices/one.pdf',data}]).toString('base64url')}}];
  const api={users:{messages:{list:async()=>({data:{messages:[{id:'m'}]}}),get:async()=>({data:msg})}}};
  const report=await testLatestEmails({api,projectRoot:dir,config:cfg,print:false,log:()=>{}});
  assert.equal(report.emails[0].status,'PROCESSED');assert.equal(report.attachments.length,1);assert.equal(report.attachments[0].invoiceNumber,'ZIP001');
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
  assert.equal(report.checkpointChanged,false);assert.equal(report.printed,false);
  assert.match(fs.readFileSync(path.join(report.outputDir,'invoices.csv'),'utf8'),/372375307838/);
});

test('ZIP searches preserve the exact old checkpoint key and select ZIP-only emails',async()=>{
  const old='in:inbox has:attachment filename:pdf';const expected='gmail-run:'+crypto.createHash('sha256').update(JSON.stringify({senders:cfg.allowedSenders,baseQuery:old})).digest('hex');
  assert.equal(checkpointKey(cfg,DEFAULT_GMAIL_QUERY),expected);assert.equal(includeZipAttachments(DEFAULT_GMAIL_QUERY),DEFAULT_GMAIL_QUERY);assert.equal(includeZipAttachments(old),DEFAULT_GMAIL_QUERY);
  assert.equal(includeZipAttachments('filename:pdf.zip -filename:pdf'),'filename:pdf.zip -filename:pdf');
  assert.match(buildQuery(old,cfg.allowedSenders,100,200),/\{filename:pdf filename:zip\}/);
  assert.equal(isSupportedAttachment({mimeType:'application/x-zip-compressed'}),true);
  const msg=message();msg.payload.parts=[{partId:'1',filename:'invoices.zip',mimeType:'application/octet-stream'}];
  const api={users:{messages:{list:async({q})=>{assert.match(q,/filename:zip/);return {data:{messages:[{id:'m'}]}};},get:async()=>({data:msg})}}};
  assert.equal((await latestPdfEmail(api,'billing@example.com')).id,'m');
});
