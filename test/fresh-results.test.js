const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {openStore} = require('../src/storage/store');
const {processText} = require('../src/services/invoiceProcessingService');
const {chooseResultMode} = require('../src/services/resultModeService');
const {clearPreviousResults} = require('../src/services/freshResultsService');
const {ensureCheckpoint,runOnce} = require('../src/services/runOnceService');
const {validateConfig} = require('../src/config');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-fresh-test-'));
  const store=openStore(dir);
  t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-fresh-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  fs.mkdirSync(path.join(dir,'pdfs'));
  const pdfPath=path.join(dir,'pdfs','old.pdf');fs.writeFileSync(pdfPath,'Original PDF bytes retained');
  const metadata=id=>({gmail_id:id,attachment_key:'part-1',sender:'billing@example.com',subject:'Saved invoice',filename:'old.pdf',sha256:'original',pdf_path:pdfPath,received_at:'2026-11-01T00:00:00Z'});
  const doc=processText('Tax Invoice\nInvoice No: FRESH001\nInvoice Date: 01/11/2026');
  store.save(metadata('first'),doc);store.save(metadata('duplicate'),doc);store.exportAll();
  return {dir,store,pdfPath,metadata,doc};
}

test('menu defaults to keeping previous results, supports fresh and cancel, and rejects invalid flags',async()=>{
  assert.equal(await chooseResultMode([],{interactive:false}),'keep');
  assert.equal(await chooseResultMode(['--keep']),'keep');
  assert.equal(await chooseResultMode(['--fresh']),'fresh');
  assert.equal(await chooseResultMode(['--choose'],{ask:async()=>''}),'keep');
  assert.equal(await chooseResultMode(['--choose'],{ask:async()=> '2'}),'fresh');
  assert.equal(await chooseResultMode(['--choose'],{ask:async()=> '3'}),'cancel');
  const answers=['invalid','1'];assert.equal(await chooseResultMode(['--choose'],{ask:async()=>answers.shift()}),'keep');
  await assert.rejects(chooseResultMode(['--fresh','--keep']),/Usage/);
});

test('fresh results archives old exports and database while preserving PDFs, tracking and checkpoint',async t=>{
  const {dir,store,pdfPath}=fixture(t);
  store.db.prepare('INSERT INTO app_state VALUES (?,?)').run('gmail-run:test',JSON.stringify({since:123,lastSuccessfulRun:'saved'}));
  const jsonFiles=fs.readdirSync(path.join(dir,'json'));
  const beforeCsv=fs.readFileSync(path.join(dir,'invoices.csv'),'utf8');
  const checkpoint=store.db.prepare('SELECT * FROM app_state').all();
  const attachments=store.db.prepare('SELECT * FROM attachments ORDER BY id').all();
  const result=await clearPreviousResults(store,dir);
  for(const table of ['invoices','invoice_line_items','invoice_numbers','duplicate_attachments','extraction_runs'])assert.equal(store.db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);
  assert.deepEqual(store.db.prepare('SELECT * FROM attachments ORDER BY id').all(),attachments);
  assert.deepEqual(store.db.prepare('SELECT * FROM app_state').all(),checkpoint);
  assert.equal(fs.readFileSync(pdfPath,'utf8'),'Original PDF bytes retained');
  assert.equal(fs.readFileSync(path.join(result.backupDir,'invoices.csv'),'utf8'),beforeCsv);
  assert.deepEqual(fs.readdirSync(path.join(result.backupDir,'json')),jsonFiles);
  assert.deepEqual(fs.readdirSync(path.join(dir,'json')),[]);
  assert.equal(fs.readFileSync(path.join(dir,'invoices.csv'),'utf8').trim().split(/\r?\n/).length,1);
  const backup=new Database(path.join(result.backupDir,'invoices.db'),{readonly:true});
  try {assert.equal(backup.prepare('SELECT count(*) n FROM invoices').get().n,1);assert.equal(backup.prepare('SELECT count(*) n FROM duplicate_attachments').get().n,1);assert.equal(backup.pragma('integrity_check',{simple:true}),'ok');}finally{backup.close();}
  assert.deepEqual(store.db.pragma('foreign_key_check'),[]);
});

test('clearing historical self-referencing duplicate records respects foreign keys',async t=>{
  const {dir,store}=fixture(t);
  const original=store.db.prepare('SELECT * FROM invoices').get();
  store.db.prepare(`INSERT INTO invoices(gmail_id,attachment_key,processed_at,duplicate_of) VALUES('legacy','legacy',?,?)`).run(original.processed_at,original.id);
  await clearPreviousResults(store,dir);
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,0);
  assert.deepEqual(store.db.pragma('foreign_key_check'),[]);
});

test('a failed database reset restores original exports and records',async t=>{
  const {dir,store}=fixture(t);
  const csv=fs.readFileSync(path.join(dir,'invoices.csv'),'utf8');
  const json=fs.readdirSync(path.join(dir,'json'));
  store.db.exec("CREATE TRIGGER block_test_reset BEFORE DELETE ON invoices BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await assert.rejects(clearPreviousResults(store,dir),/Previous results could not be cleared/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM duplicate_attachments').get().n,1);
  assert.equal(fs.readFileSync(path.join(dir,'invoices.csv'),'utf8'),csv);
  assert.deepEqual(fs.readdirSync(path.join(dir,'json')),json);
});

test('fresh mode retains the initial 24-hour boundary and the next run contains only new results',async t=>{
  const {dir,store,metadata,doc}=fixture(t);
  const config={allowedSenders:['billing@example.com'],firstRunAfter:null};
  const baseQuery='in:inbox has:attachment filename:pdf';
  const until=Date.parse('2026-11-03T00:00:00Z')/1000;
  const saved=ensureCheckpoint(store,validateConfig(config),baseQuery,until);
  assert.equal(saved.since,until-86400);
  await clearPreviousResults(store,dir);
  let query;
  const api={users:{messages:{list:async options=>{query=options.q;return {data:{messages:[{id:'new-message'}]}};}}}};
  await runOnce({store,dataDir:dir,api,config,baseQuery,now:()=>until*1000,handleMessage:async()=>{store.save(metadata('new-message'),{...doc,invoiceNumber:'FRESH002'});return {failed:false};}});
  assert.ok(query.includes('after:'+(saved.since-1)));
  assert.deepEqual(store.db.prepare('SELECT invoice_number FROM invoices').all(),[{invoice_number:'FRESH002'}]);
  const csv=fs.readFileSync(path.join(dir,'invoices.csv'),'utf8');assert.match(csv,/FRESH002/);assert.doesNotMatch(csv,/FRESH001/);
});
