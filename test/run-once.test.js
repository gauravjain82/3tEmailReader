const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {openStore} = require('../src/storage/store');
const {processText} = require('../src/services/invoiceProcessingService');
const {normalizeInvoiceNumber} = require('../src/storage/invoiceIdentity');
const {runOnce,acquireRunLock,checkpointKey,initialSince} = require('../src/services/runOnceService');
const {validateConfig,senderAddress} = require('../src/config');
const {processMessage} = require('../src/gmail/processMessage');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-batch-test-'));
  let store=openStore(dir);
  t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-batch-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,get store(){return store;},reopen(){store.close();store=openStore(dir);return store;}};
}
const config={allowedSenders:['billing@example.com'],firstRunAfter:'1970-01-01T00:01:40Z'};
function state(store) { return JSON.parse(store.db.prepare("SELECT value FROM app_state WHERE key LIKE 'gmail-run:%'").get().value); }
function apiWithPages(pages,queries) {let index=0;return {users:{messages:{list:async options=>{queries.push(options);return {data:pages[index++]||{}};}}}};}
function meta(id) {return {gmail_id:id,attachment_key:'part-1',filename:id+'.pdf',sender:'billing@example.com',subject:'Invoice',sha256:'hash-'+id,pdf_path:'retained-'+id+'.pdf'};}

test('allowlist accepts exact addresses, normalizes case and rejects an empty configuration',()=>{
  assert.deepEqual(validateConfig({allowedSenders:['BILLING@EXAMPLE.COM','billing@example.com']}).allowedSenders,['billing@example.com']);
  assert.equal(senderAddress('Supplier Name <BILLING@EXAMPLE.COM>'),'billing@example.com');
  assert.equal(senderAddress('"billing@example.com" <other@example.com>'),'other@example.com');
  assert.throws(()=>validateConfig({allowedSenders:[]}));assert.throws(()=>validateConfig({allowedSenders:['*@example.com']}));
  assert.throws(()=>validateConfig({allowedSenders:['billing@example.com OR from:other@example.com']}));
});
test('sender is checked before any PDF is downloaded, including misleading display names',async()=>{
  let downloads=0;
  const api={users:{messages:{get:async()=>({data:{payload:{headers:[{name:'From',value:'"billing@example.com" <other@example.com>'}],parts:[{mimeType:'application/pdf',body:{attachmentId:'a'}}]}}}),attachments:{get:async()=>{downloads++;throw Error('Must not download');}}}}};
  const result=await processMessage(api,'m',{},'unused',{allowedSenders:['billing@example.com']});
  assert.equal(result.skippedSender,true);assert.equal(downloads,0);
});
test('one run drains every page and the next run uses the completed time window',async t=>{
  const {dir,store}=fixture(t);const queries=[],handled=[];
  const first=await runOnce({store,dataDir:dir,config,now:()=>200000,api:apiWithPages([{messages:[{id:'a'}],nextPageToken:'next'},{messages:[{id:'a'},{id:'b'}]}],queries),handleMessage:async(a,id,s,d,options)=>{handled.push(id);assert.deepEqual(options.allowedSenders,['billing@example.com']);return {failed:false};}});
  assert.equal(first.messagesChecked,2);assert.deepEqual(handled,['a','b']);assert.equal(queries.length,2);
  assert.match(queries[0].q,/from:billing@example.com/);assert.match(queries[0].q,/after:99 before:200$/);
  assert.equal(state(store).since,200);
  const nextQueries=[];await runOnce({store,dataDir:dir,config,now:()=>300000,api:apiWithPages([{}],nextQueries)});
  assert.match(nextQueries[0].q,/after:199 before:300$/);assert.equal(state(store).since,300);
});
test('partial failure and export failure do not advance the checkpoint',async t=>{
  const {dir,store}=fixture(t);
  const options={store,dataDir:dir,config,now:()=>200000,api:apiWithPages([{messages:[{id:'bad'}]}],[]),handleMessage:async()=>({failed:true})};
  await assert.rejects(runOnce(options),/checkpoint was not advanced/);assert.equal(state(store).since,100);
  const original=store.exportAll;store.exportAll=()=>{throw Error('CSV locked');};
  await assert.rejects(runOnce({...options,api:apiWithPages([{}],[])}),/CSV locked/);assert.equal(state(store).since,100);
  store.exportAll=original;
  await runOnce({...options,api:apiWithPages([{}],[])});assert.equal(state(store).since,200);
});
test('list failure leaves the initial checkpoint durable for a retry',async t=>{
  const {dir,store}=fixture(t);
  const api={users:{messages:{list:async()=>{throw Error('Request failed');}}}};
  await assert.rejects(runOnce({store,dataDir:dir,config,now:()=>200000,api}),/Request failed/);
  assert.equal(state(store).since,100);
});
test('first run defaults to the last 24 hours regardless of historical receipt times',t=>{
  const {store}=fixture(t);
  store.save({...meta('m'),sender:'Supplier <billing@example.com>',received_at:'2026-11-01T00:00:00Z'},processText('Tax Invoice\nInvoice No: BOOT001'));
  const parsed=validateConfig({allowedSenders:['billing@example.com']});
  const until=Date.parse('2026-11-03T12:00:00Z')/1000;
  assert.equal(initialSince(store,parsed,until),until-86400);
  assert.equal(initialSince(store,validateConfig({allowedSenders:['new@example.com']}),until),until-86400);
  assert.equal(initialSince(store,validateConfig(config),until),100);
  assert.notEqual(checkpointKey(parsed,'has:attachment'),checkpointKey(validateConfig({allowedSenders:['new@example.com']}),'has:attachment'));
});
test('first-run 24-hour boundary is retained after failure and subsequent runs use checkpoints',async t=>{
  const {dir,store}=fixture(t);const firstNow=Date.parse('2026-11-03T12:00:00Z');const queries=[];
  const cfg={allowedSenders:['billing@example.com'],firstRunAfter:null};
  const opts={store,dataDir:dir,config:cfg,now:()=>firstNow,api:apiWithPages([{messages:[{id:'bad'}]}],queries),handleMessage:async()=>({failed:true})};
  await assert.rejects(runOnce(opts),/checkpoint was not advanced/);
  const firstSince=firstNow/1000-86400;assert.equal(state(store).since,firstSince);
  assert.match(queries[0].q,new RegExp('after:'+(firstSince-1)+' before:'+firstNow/1000+'$'));
  const retryNow=firstNow+3*86400000;const retryQueries=[];
  await runOnce({...opts,now:()=>retryNow,api:apiWithPages([{}],retryQueries)});
  assert.match(retryQueries[0].q,new RegExp('after:'+(firstSince-1)+' before:'+retryNow/1000+'$'));
  assert.equal(state(store).since,retryNow/1000);
  const nextQueries=[];await runOnce({...opts,now:()=>retryNow+10000,api:apiWithPages([{}],nextQueries)});
  assert.match(nextQueries[0].q,new RegExp('after:'+(retryNow/1000-1)+' before:'+(retryNow/1000+10)+'$'));
});
test('a second launch is blocked until the current run releases its lock',t=>{
  const {dir}=fixture(t);const unlock=acquireRunLock(dir);assert.throws(()=>acquireRunLock(dir),/already active/);unlock();const second=acquireRunLock(dir);second();assert.equal(fs.existsSync(path.join(dir,'extractor.lock')),false);
});
test('invoice-number duplicates across emails do not create invoice rows; provenance is exported',t=>{
  const {store,dir}=fixture(t);
  const doc=processText('Tax Invoice\nInvoice No: INV-0001\nInvoice Date: 03/11/2026');
  const first=store.save(meta('first'),doc);
  const duplicate=store.save(meta('second'),{...doc,invoiceNumber:' inv-0001 '});
  assert.equal(duplicate.is_duplicate,true);assert.equal(duplicate.duplicate_of,first.id);
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM duplicate_attachments').get().n,1);
  store.exportAll();
  const d=store.db.prepare('SELECT * FROM duplicate_attachments').get();const exported=JSON.parse(fs.readFileSync(d.json_path,'utf8'));
  assert.equal(exported.gmailMessageId,'second');assert.equal(exported.duplicateOf,first.id);assert.equal(exported.isDuplicate,true);
  assert.match(fs.readFileSync(path.join(dir,'duplicates.csv'),'utf8'),/second/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir,'invoices.csv'),'utf8'),/second/);
  store.save(meta('third'),{...doc,invoiceNumber:'INV-0002'});assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,2);
});
test('blank or malformed invoice numbers and non-invoices are never collapsed together',t=>{
  const {store}=fixture(t);
  for(const n of [null,'','HSN','GSTIN'])assert.equal(normalizeInvoiceNumber(n),null);
  assert.equal(normalizeInvoiceNumber(' inv/0001 '),'INV/0001');assert.notEqual(normalizeInvoiceNumber('001'),normalizeInvoiceNumber('1'));
  for(const id of ['a','b'])store.save(meta(id),processText('Tax Invoice\nInvoice No: GSTIN'));
  for(const id of ['c','d'])store.save(meta(id),processText('Bin No. 1 QTY/BIN 10'));
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,4);
});
test('migration flags historical duplicate rows without deleting records or changing IDs',t=>{
  const f=fixture(t);const first=f.store.save(meta('first'),processText('Tax Invoice\nInvoice No: HIST001'));
  const columns=f.store.db.prepare('PRAGMA table_info(invoices)').all().map(c=>c.name).filter(c=>c!=='id');
  const expressions=columns.map(c=>c==='gmail_id'?"'legacy-copy'":c==='normalized_invoice_number'?'NULL':c==='duplicate_of'?'NULL':c);
  f.store.db.prepare(`INSERT INTO invoices(${columns.join(',')}) SELECT ${expressions.join(',')} FROM invoices WHERE id=?`).run(first.id);
  const ids=f.store.db.prepare('SELECT id FROM invoices ORDER BY id').all();
  f.store.db.exec('DELETE FROM invoice_numbers; DELETE FROM schema_migrations WHERE version=3');
  const store=f.reopen();assert.deepEqual(store.db.prepare('SELECT id FROM invoices ORDER BY id').all(),ids);
  assert.equal(store.db.prepare('SELECT duplicate_of FROM invoices WHERE gmail_id=?').get('legacy-copy').duplicate_of,first.id);
  assert.equal(store.db.pragma('integrity_check',{simple:true}),'ok');
});
