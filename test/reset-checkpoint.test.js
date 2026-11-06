const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {openStore}=require('../src/storage/store');
const {validateConfig}=require('../src/config');
const {checkpointKey,acquireRunLock,runOnce}=require('../src/services/runOnceService');
const {parseResetTime,resetCheckpoint}=require('../src/services/resetCheckpointService');
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
