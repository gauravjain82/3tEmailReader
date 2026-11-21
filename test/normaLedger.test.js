const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {normaWorkbook,normaText}=require('./helpers/normaFixture');
const {Workbook,elements}=require('../src/norma/xlsx');
const {parseNormaText}=require('../src/norma/parser');
const {SHEETS,addInvoice,salesRows,syncStock}=require('../src/norma/workbook');
const {LEDGER,OPENINGS,readInputs,syncLedger,verifyLedger}=require('../src/norma/ledger');
const {migrateWorkbook}=require('../src/norma/migrate');
const {runNorma}=require('../src/norma/service');
const invoice=()=>parseNormaText(normaText())[0];
function migrated({sales=true,throughDate='2026-11-12'}={}){const book=new Workbook(normaWorkbook());if(sales)addInvoice(book,invoice());return new Workbook(migrateWorkbook(book.pack(),{fromDate:'2026-11-10',throughDate}).bytes);}
function rowOf(book,date,region='gurgaon',part='13892M74L60'){return readInputs(book).rows.get(date+':'+region+':'+part)?.row;}
function fixture(t,book=migrated()){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'norma-ledger-')),config={workbookPath:path.join(root,'Norma.xlsx'),pendingDirectory:path.join(root,'Pending'),doneDirectory:path.join(root,'Done'),backupDirectory:path.join(root,'Backups'),reportDirectory:path.join(root,'Reports')};fs.writeFileSync(config.workbookPath,book.pack());fs.mkdirSync(config.pendingDirectory);
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('norma-ledger-'));fs.rmSync(root,{recursive:true,force:true});});return {config};
}
test('migration retains sales and old stock, saves explicit numeric openings and reconciles both regions',()=>{
  const original=new Workbook(normaWorkbook());addInvoice(original,invoice());const before=original.pack(),result=migrateWorkbook(before,{fromDate:'2026-11-10',throughDate:'2026-11-12'}),book=new Workbook(result.bytes);
  for(const region of ['gurgaon','gujarat'])assert.deepEqual(salesRows(book,region),salesRows(original,region));
  const old=book.sheet(SHEETS.stock);for(const [ref] of original.sheet(SHEETS.stock).cells){assert.equal(old.value(ref),original.sheet(SHEETS.stock).value(ref));assert.equal(old.formula(ref),original.sheet(SHEETS.stock).formula(ref));}
  const seed=readInputs(book).seeds.get('gurgaon:13892M74L60');assert.equal(book.sheet(OPENINGS).value('D'+seed.row),'950');assert.equal(book.sheet(OPENINGS).formula('D'+seed.row),'');assert.equal(result.report.stock.reconciliation.verified,true);assert.equal(result.report.stock.reconciliation.rows,6);
  const stock=book.sheet(LEDGER),row=rowOf(book,'2026-11-10');assert.equal(stock.value('G'+row),'250');assert.equal(stock.value('H'+row),'700');assert.equal(stock.formula('H'+row),'');assert.equal(stock.value('D'+rowOf(book,'2026-11-11')),'700');
});
test('idle run repairs previously blank dispatch and stale following opening without PDFs or a from-date',async t=>{
  const book=migrated(),sheet=book.sheet(LEDGER),row=rowOf(book,'2026-11-10');sheet.set('G'+row,'');sheet.number('H'+row,950);sheet.number('D'+rowOf(book,'2026-11-11'),950);const {config}=fixture(t,book);
  const report=await runNorma(config,{throughDate:'2026-11-12',log:()=>{}});assert.deepEqual(report.errors,[]);assert.equal(report.stock[0].format,'ledger-v1');assert.equal(report.stock[0].reconciliation.verified,true);const saved=new Workbook(fs.readFileSync(config.workbookPath));assert.equal(saved.sheet(LEDGER).value('G'+row),'250');assert.equal(saved.sheet(LEDGER).value('D'+rowOf(saved,'2026-11-11')),'700');assert.equal(salesRows(saved,'gurgaon').length,1);
});
test('manual receipts, transfer and Transit survive and old sales edits propagate through all following days',()=>{
  const book=migrated(),sheet=book.sheet(LEDGER),row=rowOf(book,'2026-11-10');sheet.number('E'+row,100);sheet.number('F'+row,25);sheet.number('I'+row,50);sheet.set('J'+row,'Manual receipt');book.sheet(SHEETS.gurgaon).number('E2',500);
  const report=syncStock(book,{throughDate:'2026-11-12'});assert.equal(report.format,'ledger-v1');assert.equal(sheet.value('D'+row),'950');assert.equal(sheet.value('G'+row),'500');assert.equal(sheet.value('H'+row),'525');assert.equal(sheet.value('H'+rowOf(book,'2026-11-12')),'525');for(const [col,value] of [['E','100'],['F','25'],['I','50'],['J','Manual receipt']])assert.equal(sheet.value(col+row),value);
});
test('sorting rows and inserting gaps does not affect identity or carry-forward balances',()=>{
  const book=migrated(),sheet=book.sheet(LEDGER),data=[...readInputs(book).rows.values()].reverse().map(r=>'ABCDEFGHIJ'.split('').map(c=>sheet.value(c+r.row)));
  // Rebuild the physical rows in the opposite order with empty rows between.
  for(const node of [...sheet.rows.values()])if(Number(node.getAttribute('r'))>1)node.parentNode.removeChild(node);sheet.rows=new Map([...sheet.rows].filter(([r])=>r===1));sheet.cells=new Map([...sheet.cells].filter(([ref])=>/^[A-Z]+1$/.test(ref)));
  data.forEach((values,index)=>values.forEach((v,i)=>sheet.set(String.fromCharCode(65+i)+(index*2+3),['D','E','F','G','H','I'].includes(String.fromCharCode(65+i))&&v!==''?Number(v):v)));
  const row=rowOf(book,'2026-11-10');sheet.number('E'+row,100);syncLedger(book,{throughDate:'2026-11-12'});assert.equal(sheet.value('H'+row),'800');assert.equal(sheet.value('D'+rowOf(book,'2026-11-12')),'800');verifyLedger(new Workbook(book.pack()),{throughDate:'2026-11-12'});
});
test('new stock parts start at zero once and reruns never subtract their sales twice',()=>{
  const book=migrated(),doc=invoice();doc.invoiceNumber='2620008782';doc.date='2026-11-11';doc.items[0].partNumber='13894M74L50';addInvoice(book,doc);const first=syncLedger(book,{throughDate:'2026-11-12'});assert.deepEqual(first.newParts,['gurgaon:13894M74L50']);const sheet=book.sheet(LEDGER),row=rowOf(book,'2026-11-11','gurgaon','13894M74L50');assert.equal(sheet.value('D'+row),'0');assert.equal(sheet.value('H'+row),'-250');const second=syncLedger(book,{throughDate:'2026-11-12'});assert.deepEqual(second.newParts,[]);assert.equal(sheet.value('H'+rowOf(book,'2026-11-12','gurgaon','13894M74L50')),'-250');
});
test('missing historical derived values and #REF formulas are rebuilt from seeds instead of followed',()=>{
  const book=migrated(),sheet=book.sheet(LEDGER);for(const row of readInputs(book).rows.values())for(const col of ['D','G','H']){sheet.number(col+row.row,0,{formula:'#REF!'});const cell=sheet.cells.get(col+row.row);cell.setAttribute('t','e');elements(cell,'v')[0].textContent='#REF!';}
  syncLedger(book,{throughDate:'2026-11-12'});assert.equal(sheet.value('H'+rowOf(book,'2026-11-12')),'700');verifyLedger(new Workbook(book.pack()),{throughDate:'2026-11-12'});
});
test('duplicate ledger keys and bad manual formulas prevent saving or archiving',async t=>{
  for(const kind of ['duplicate','formula']){const book=migrated(),sheet=book.sheet(LEDGER),row=rowOf(book,'2026-11-10');if(kind==='formula')sheet.number('E'+row,100,{formula:'#REF!'});else {const target=sheet.maxRow()+1;for(const col of 'ABC')sheet.set(col+target,sheet.value(col+row));}const {config}=fixture(t,book),before=fs.readFileSync(config.workbookPath);fs.writeFileSync(path.join(config.pendingDirectory,'invoice.pdf'),'mock');const report=await runNorma(config,{throughDate:'2026-11-12',parsePdf:async()=>[invoice()],log:()=>{}});assert.equal(report.files[0].status,'FAILED');assert.match(report.errors[0].error,kind==='duplicate'?/Duplicate stock ledger/:/Enter a number/);assert.deepEqual(fs.readFileSync(config.workbookPath),before);assert.ok(fs.existsSync(path.join(config.pendingDirectory,'invoice.pdf')));}
});
test('invalid sales rows are reported instead of silently omitted from stock',()=>{
  for(const [col,value] of [['D','UNKNOWN'],['C','bad date'],['E','bad quantity'],['B','wrong invoice']]){const book=migrated();book.sheet(SHEETS.gurgaon).set(col+'2',value);assert.throws(()=>syncLedger(book,{throughDate:'2026-11-12'}),/Invalid|Use an ISO/);}
});
test('opening baseline errors and duplicate opening parts are rejected',()=>{
  for(const kind of ['missing','duplicate','formula']){const book=migrated(),s=book.sheet(OPENINGS);if(kind==='missing')s.set('D2','');else if(kind==='formula')s.number('D2',0,{formula:'#REF!'});else {const row=s.maxRow()+1;for(const col of 'ABC')s.set(col+row,s.value(col+'2'));s.number('D'+row,950);}assert.throws(()=>syncLedger(book,{throughDate:'2026-11-12'}),/Missing number|Duplicate stock opening|Enter a number/);}
});
test('adding a new invoice before the cutover is refused without changing the workbook',async t=>{
  const {config}=fixture(t),before=fs.readFileSync(config.workbookPath),doc=invoice();doc.invoiceNumber='2620008782';doc.date='2026-11-09';fs.writeFileSync(path.join(config.pendingDirectory,'old.pdf'),'mock');const report=await runNorma(config,{throughDate:'2026-11-12',parsePdf:async()=>[doc],log:()=>{}});assert.equal(report.files[0].status,'FAILED');assert.match(report.errors[0].error,/predates the verified ledger opening/);assert.deepEqual(fs.readFileSync(config.workbookPath),before);
});
test('legacy history can be broken after migration without affecting the continuous ledger',()=>{
  const book=migrated();book.sheet(SHEETS.stock).number('G3',0,{formula:'#REF!'});syncStock(book,{throughDate:'2026-11-13'});assert.equal(book.sheet(LEDGER).value('H'+rowOf(book,'2026-11-13')),'700');
});
test('migration imports manual movements on and after the cutover and retains future manual entries',()=>{
  const original=new Workbook(normaWorkbook());syncStock(original,{throughDate:'2026-11-12'});const old=original.sheet(SHEETS.stock);const {stockBlocks}=require('../src/norma/workbook');const row=stockBlocks(old,'gurgaon').find(b=>b.date==='2026-11-11').parts.get('13892M74L60');old.number('D'+row,100);old.number('E'+row,25);
  const book=new Workbook(migrateWorkbook(original.pack(),{fromDate:'2026-11-10',throughDate:'2026-11-10'}).bytes),sheet=book.sheet(LEDGER),future=rowOf(book,'2026-11-11');assert.equal(sheet.value('E'+future),'100');assert.equal(sheet.value('F'+future),'25');syncLedger(book,{throughDate:'2026-11-12'});assert.equal(sheet.value('H'+rowOf(book,'2026-11-12')),'1025');
});
test('migration is explicit, refuses repeated conversion and requires valid saved initial balances',()=>{
  assert.throws(()=>migrateWorkbook(normaWorkbook(),{fromDate:'2026-02-30'}),/valid --from/);assert.throws(()=>migrateWorkbook(normaWorkbook(),{fromDate:'2026-11-09'}),/No earlier verified/);assert.throws(()=>migrateWorkbook(migrated().pack(),{fromDate:'2026-11-10',throughDate:'2026-11-12'}),/already contains ledger/);const bad=new Workbook(normaWorkbook());bad.sheet(SHEETS.stock).set('G3','');assert.throws(()=>migrateWorkbook(bad.pack(),{fromDate:'2026-11-10',throughDate:'2026-11-12'}),/Latest stock entry/);
});
test('ledger reconciliation still runs if every Pending PDF fails to parse',async t=>{
  const book=migrated(),row=rowOf(book,'2026-11-10');book.sheet(LEDGER).set('G'+row,'');const {config}=fixture(t,book);fs.writeFileSync(path.join(config.pendingDirectory,'bad.pdf'),'invalid');const report=await runNorma(config,{throughDate:'2026-11-12',parsePdf:async()=>{throw Error('Bad PDF');},log:()=>{}});assert.equal(report.errors.length,1);assert.equal(report.stock[0].reconciliation.verified,true);assert.equal(new Workbook(fs.readFileSync(config.workbookPath)).sheet(LEDGER).value('G'+row),'250');
});

test('malformed legacy dates bounded by pre-cutover dates are audited without guessing a date',()=>{
  const original=new Workbook(normaWorkbook());for(const [number,date] of [['2620008701','2026-11-08'],['2620008702','2026-11-08'],['2620008703','2026-11-09']])addInvoice(original,{...invoice(),invoiceNumber:number,date});original.sheet(SHEETS.gurgaon).set('C3','08/11/206');addInvoice(original,invoice());
  const result=migrateWorkbook(original.pack(),{fromDate:'2026-11-10',throughDate:'2026-11-12'}),book=new Workbook(result.bytes);assert.equal(result.report.excludedLegacyDateRows.length,1);assert.equal(book.sheet(SHEETS.gurgaon).value('C3'),'08/11/206');assert.equal(result.report.stock.reconciliation.excludedHistoricalSales,1);assert.equal(book.sheet(LEDGER).value('H'+rowOf(book,'2026-11-12')),'700');
  // Sorting has no effect on the audited identity; an edit must be reviewed.
  book.sheet(SHEETS.gurgaon).number('E3',999);assert.throws(()=>syncLedger(book,{throughDate:'2026-11-12'}),/Use an ISO|archived historical/);
});
test('ambiguous recent invalid dates cannot be archived by migration',()=>{
  const original=new Workbook(normaWorkbook());addInvoice(original,invoice());original.sheet(SHEETS.gurgaon).set('C2','19/11/206');assert.throws(()=>migrateWorkbook(original.pack(),{fromDate:'2026-11-10',throughDate:'2026-11-12'}),/cannot be established as history/);
});
test('Indian text dates and Excel date numbers identify the same ledger date',()=>{
  const book=migrated(),sheet=book.sheet(LEDGER),row=rowOf(book,'2026-11-10');sheet.set('A'+row,'10/11/2026');book.sheet(SHEETS.gurgaon).set('C2','10.11.2026');syncLedger(book,{throughDate:'2026-11-12'});assert.equal(sheet.value('A'+row),'2026-11-10');assert.equal(sheet.value('G'+row),'250');verifyLedger(book,{throughDate:'2026-11-12'});
});
test('a late invoice for a newly encountered part recalculates earlier days within the baseline',async t=>{
  const book=migrated(),doc=invoice();doc.invoiceNumber='2620008782';doc.date='2026-11-12';doc.items[0].partNumber='13894M74L50';addInvoice(book,doc);syncLedger(book,{throughDate:'2026-11-12'});const {config}=fixture(t,book),late={...doc,invoiceNumber:'2620008783',date:'2026-11-11'};fs.writeFileSync(path.join(config.pendingDirectory,'late.pdf'),'mock');const report=await runNorma(config,{throughDate:'2026-11-12',parsePdf:async()=>[late],log:()=>{}});assert.deepEqual(report.errors,[]);assert.equal(report.files[0].status,'DONE');const saved=new Workbook(fs.readFileSync(config.workbookPath));assert.equal(saved.sheet(LEDGER).value('H'+rowOf(saved,'2026-11-12','gurgaon','13894M74L50')),'-500');
});
test('Gurgaon and Gujarat dispatch and manual movements are reconciled independently',()=>{
  const book=migrated(),doc={...invoice(),invoiceNumber:'2620008782',region:'gujarat',plant:'SMG'};addInvoice(book,doc);const s=book.sheet(LEDGER),left=rowOf(book,'2026-11-10'),right=rowOf(book,'2026-11-10','gujarat');s.number('F'+left,25);s.number('E'+right,100);s.number('I'+right,500);const result=syncLedger(book,{throughDate:'2026-11-12'});assert.equal(s.value('H'+left),'675');assert.equal(s.value('H'+right),'1900');assert.equal(s.value('I'+right),'500');assert.equal(result.reconciliation.dispatchQuantity,500);
});
test('migration deducts intervening sales when a part has no stock row immediately before cutover',()=>{
  const book=new Workbook(normaWorkbook());addInvoice(book,invoice());const result=migrateWorkbook(book.pack(),{fromDate:'2026-11-11',throughDate:'2026-11-12'}),saved=new Workbook(result.bytes);assert.equal(result.report.openingBalances.find(s=>s.region==='gurgaon').quantity,700);assert.equal(saved.sheet(LEDGER).value('D'+rowOf(saved,'2026-11-11')),'700');
});
