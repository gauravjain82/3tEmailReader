const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const crypto=require('crypto');
const {PDFDocument}=require('pdf-lib');
const {latestPdfEmail,testLatestEmails}=require('../src/services/latestEmailTestService');

const header=(from)=>[{name:'From',value:from},{name:'Subject',value:'Latest invoice test'}];
const message=(id,from,date,pdf)=>({id,internalDate:String(date),payload:{headers:header(from),parts:pdf?[{partId:'1',mimeType:'application/pdf',filename:'Original Invoice.pdf',body:{data:pdf.toString('base64url')}}]:[]}});
async function pdfBytes(number) {
  const pdf=await PDFDocument.create();
  pdf.addPage().drawText(`Tax Invoice\nInvoice No: ${number}\nInvoice Date: 04.11.2026\nTaxable Value: 100.00\nTotal Amount: 118.00`,{x:20,y:700,size:12,lineHeight:20});
  return Buffer.from(await pdf.save());
}
test('latest email selection checks exact From and received dates across all pages, not Gmail list order',async()=>{
  const messages={old:message('old','a@company.test',100,Buffer.from('pdf')),new:message('new','A Sender <A@company.test>',500,Buffer.from('pdf')),spoof:message('spoof','a@company.test <outsider@company.test>',900,Buffer.from('pdf'))};
  const calls=[];
  const api={users:{messages:{list:async args=>{
    assert.equal(args.q,'from:a@company.test has:attachment filename:pdf');
    return {data:args.pageToken?{messages:[{id:'new'},{id:'spoof'}]}:{messages:[{id:'old'}],nextPageToken:'page2'}};
  },get:async args=>{calls.push(args);return {data:messages[args.id]};}}}};
  assert.equal((await latestPdfEmail(api,'a@company.test')).id,'new');
  assert.deepEqual(calls.filter(c=>c.format==='full').map(c=>c.id),['new']);
});

test('isolated latest-email run preserves live files/checkpoint and checks duplicate attachment signatures',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-latest-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'data'));
  const liveFiles=['invoices.db','invoices.csv','signature-report.csv','last-run-invoices.json'];
  for(const file of liveFiles)fs.writeFileSync(path.join(root,'data',file),'Live results/checkpoint sentinel '+file);
  const before=liveFiles.map(file=>fs.readFileSync(path.join(root,'data',file)));
  const bytes=await pdfBytes('TEST001');
  const msg=message('new','billing@company.test',500,bytes);
  msg.payload.parts.push({...msg.payload.parts[0],partId:'2'});
  const api={users:{messages:{list:async()=>({data:{messages:[{id:'new'}]}}),get:async()=>({data:msg})}}};
  let checks=0;
  const run=()=>testLatestEmails({api,projectRoot:root,config:{allowedSenders:['Billing@company.test'],firstRunAfter:'2099-01-01T00:00:00Z'},log:()=>{},verifySignature:async(file,hash)=>{
    checks++;assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),hash);
    return {schemaVersion:1,status:'VALID',reason:'Mocked verification for isolated test',signatures:[]};
  }});
  const first=await run();
  assert.equal(first.emails[0].status,'PROCESSED');assert.equal(first.attachments.length,2);assert.equal(checks,2);
  assert.equal(first.printed,false);assert.equal(first.checkpointChanged,false);
  assert.equal(fs.existsSync(path.join(first.outputDir,'invoices.csv')),true);
  assert.equal(fs.existsSync(path.join(first.outputDir,'failure-report.csv')),true);
  assert.equal(fs.readFileSync(path.join(first.outputDir,'attachment-signatures.csv'),'utf8').split('\r\n').length,4);
  const db=require('better-sqlite3')(path.join(first.outputDir,'invoices.db'),{readonly:true});
  assert.equal(db.prepare('SELECT count(*) n FROM app_state').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM print_jobs').get().n,0);db.close();
  const second=await run();assert.notEqual(first.outputDir,second.outputDir);assert.equal(second.attachments.length,2);
  liveFiles.forEach((file,i)=>assert.deepEqual(fs.readFileSync(path.join(root,'data',file)),before[i]));
});

test('latest email errors, missing senders and signature failures remain reviewable without live updates',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-latest-errors-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const bytes=await pdfBytes('TEST002');
  const api={users:{messages:{list:async({q})=>{
    if(q.includes('a@company.test'))throw Error('API unavailable');
    return {data:{messages:q.includes('b@company.test')?[{id:'b'}]:[]}};
  },get:async()=>({data:message('b','b@company.test',500,bytes)})}}};
  const report=await testLatestEmails({api,projectRoot:root,config:{allowedSenders:['a@company.test','b@company.test','c@company.test']},log:()=>{},verifySignature:async()=>({status:'UNKNOWN',reason:'Missing trust chain',signatures:[]})});
  assert.deepEqual(report.emails.map(e=>e.status),['FAILED','PROCESSED','NO_MATCH']);
  assert.equal(report.hasIssues,true);
  assert.match(fs.readFileSync(path.join(report.outputDir,'attachment-signatures.csv'),'utf8'),/Missing trust chain/);
  assert.equal(fs.existsSync(path.join(root,'data','invoices.db')),false);
});

test('repeated Gmail pagination tokens stop the test instead of looping',async()=>{
  const api={users:{messages:{list:async()=>({data:{messages:[],nextPageToken:'repeat'}})}}};
  await assert.rejects(latestPdfEmail(api,'billing@company.test'),/repeated pagination/);
});
