const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {openStore}=require('../src/storage/store');
const {validateConfig}=require('../src/config');
const {checkpointKey,acquireRunLock,runOnce}=require('../src/services/runOnceService');
const {parseResetTime,resetCheckpoint}=require('../src/services/resetCheckpointService');
const {processMessage}=require('../src/gmail/processMessage');
const {clearPreviousResults}=require('../src/services/freshResultsService');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const now=Date.parse('2026-11-06T12:00:00+05:30');
const config={allowedSenders:['billing@example.com']};
const baseQuery='in:inbox has:attachment filename:pdf';
function folder(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reset-checkpoint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('reset date/time uses IST and rejects invalid, ambiguous or future input',()=>{
  assert.equal(parseResetTime('06-11-2026','06:00',now),Date.parse('2026-11-06T00:30:00Z')/1000);
  for(const [date,time] of [['31-02-2026','06:00'],['06/11/2026','06:00'],['06-11-2026','24:00'],['06-11-2026','6:00'],['06-11-2026','12:01'],['07-11-2026','00:00'],['01-01-1960','06:00']])assert.throws(()=>parseResetTime(date,time,now));
});
test('reset replaces only the active checkpoint, keeps attachment/data files, and records previous state',async t=>{
  const dir=folder(t),key=checkpointKey(validateConfig(config),baseQuery),old=JSON.stringify({since:100,pendingRunId:'previous-attempt'});
  let store=openStore(dir);
  store.db.prepare('INSERT INTO app_state(key,value) VALUES (?,?)').run(key,old);
  store.db.prepare('INSERT INTO app_state(key,value) VALUES (?,?)').run('gmail-run:other-senders','other checkpoint');
  store.markAttachment({gmail_id:'old-mail',attachment_key:'part-1',filename:'saved.pdf'},'done');
  store.close();
  fs.mkdirSync(path.join(dir,'pdfs'));fs.writeFileSync(path.join(dir,'pdfs','saved.pdf'),'original bytes');
  fs.writeFileSync(path.join(dir,'invoices.csv'),'retained CSV');
  fs.writeFileSync(path.join(dir,'last-run-invoices.json'),'retained last batch');
  const since=parseResetTime('06-11-2026','06:00',now);
  const result=resetCheckpoint({dataDir:dir,config,baseQuery,since,now});
  store=openStore(dir);
  try{
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT value FROM app_state WHERE key=?').get(key).value),{since});
    const audit=JSON.parse(store.db.prepare('SELECT value FROM app_state WHERE key=?').get(result.historyKey).value);
    assert.equal(audit.previousValue,old);
    assert.equal(store.db.prepare("SELECT value FROM app_state WHERE key='gmail-run:other-senders'").get().value,'other checkpoint');
    assert.equal(store.find('old-mail','part-1').status,'done');
    assert.equal(fs.readFileSync(path.join(dir,'invoices.csv'),'utf8'),'retained CSV');
    assert.equal(fs.readFileSync(path.join(dir,'pdfs','saved.pdf'),'utf8'),'original bytes');
    assert.equal(fs.readFileSync(path.join(dir,'last-run-invoices.json'),'utf8'),'retained last batch');
    const queries=[];
    const api={users:{messages:{list:async o=>{queries.push(o.q);return {data:{messages:[]}};}}}};
    await runOnce({api,store,dataDir:dir,config,baseQuery,now:()=>now});
    assert(queries[0].includes(`after:${since-1}`));
  }finally{store.close();}
});
test('reset refuses an active extractor and does not change the checkpoint',t=>{
  const dir=folder(t),unlock=acquireRunLock(dir);
  try{assert.throws(()=>resetCheckpoint({dataDir:dir,config,since:100,now}),/already active/);assert.equal(fs.existsSync(path.join(dir,'invoices.db')),false);}finally{unlock();}
  assert.throws(()=>resetCheckpoint({dataDir:dir,config,since:Math.floor(now/1000)+1,now}),/future/);
  assert.equal(fs.existsSync(path.join(dir,'invoices.db')),false);
});
test('replay rebuilds archived results despite done attachment tracking, retains deduplication and stops after success',async t=>{
  const dir=folder(t),since=parseResetTime('06-11-2026','06:00',now);
  const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('TAX INVOICE\nInvoice No: REPLAY001\nInvoice Date: 06.11.2026',{x:30,y:700,font,size:12});
  const bytes=Buffer.from(await pdf.save());
  const api={users:{messages:{list:async()=>({data:{messages:[{id:'old-mail'}]}}),get:async()=>({data:{internalDate:String((since+60)*1000),payload:{headers:[{name:'From',value:'billing@example.com'}],parts:['1','2'].map(partId=>({partId,filename:'old.pdf',mimeType:'application/pdf',body:{data:bytes.toString('base64url')}}))}}})}}};
  let store=openStore(dir);
  try{
    await processMessage(api,'old-mail',store,dir,{runId:'original-run'});
    await clearPreviousResults(store,dir);
    assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
    assert.equal(store.find('old-mail','part-1').status,'done');
  }finally{store.close();}
  resetCheckpoint({dataDir:dir,config,since,replay:true,now});
  store=openStore(dir);
  try{
    const result=await runOnce({api,store,dataDir:dir,config,now:()=>now});
    assert.equal(result.invoiceIds.length,1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
    assert.equal(store.db.prepare('SELECT count(*) n FROM duplicate_attachments').get().n,1);
    assert.equal(store.find('old-mail','part-1').attempts,2);
    assert.equal(store.db.prepare('SELECT count(*) n FROM print_jobs').get().n,0);
    const state=JSON.parse(store.db.prepare('SELECT value FROM app_state WHERE key=?').get(checkpointKey(validateConfig(config),baseQuery)).value);
    assert.equal(state.replay,undefined);
    await runOnce({api,store,dataDir:dir,config,now:()=>now+1000});
    assert.equal(store.find('old-mail','part-1').attempts,2);
  }finally{store.close();}
  // Keeping existing results must re-extract the canonical attachment, not insert duplicates.
  resetCheckpoint({dataDir:dir,config,since,replay:true,now:now+2000});
  store=openStore(dir);
  try{
    await runOnce({api,store,dataDir:dir,config,now:()=>now+2000});
    assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
    assert.equal(store.find('old-mail','part-1').attempts,3);
    assert.ok(store.db.prepare('SELECT reprocessed_at FROM invoices').get().reprocessed_at);
  }finally{store.close();}
});
test('failed replay keeps its replay flag for retry and leaves other sender checkpoints unchanged',async t=>{
  const dir=folder(t),since=parseResetTime('06-11-2026','06:00',now);
  resetCheckpoint({dataDir:dir,config,since,replay:true,now});
  const store=openStore(dir);
  try{
    const api={users:{messages:{list:async()=>({data:{messages:[{id:'retry-mail'}]}})}}};
    await assert.rejects(runOnce({api,store,dataDir:dir,config,now:()=>now,handleMessage:async(a,id,s,d,options)=>{
      assert.equal(options.reprocessCompleted,true);return {failed:true};
    }}),/checkpoint was not advanced/);
    const state=JSON.parse(store.db.prepare('SELECT value FROM app_state WHERE key=?').get(checkpointKey(validateConfig(config),baseQuery)).value);
    assert.equal(state.replay,true);assert.equal(state.since,since);
    await runOnce({api,store,dataDir:dir,config,now:()=>now+1000,handleMessage:async(a,id,s,d,options)=>{assert.equal(options.reprocessCompleted,true);return {failed:false};}});
  }finally{store.close();}
});
