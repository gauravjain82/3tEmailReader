const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),os=require('os'),path=require('path');
const {normaWorkbook,normaText}=require('./helpers/normaFixture');
const {parseNormaText,parseNormaPdf}=require('../src/norma/parser');const {Workbook,NS,elements}=require('../src/norma/xlsx');
const {addInvoice,syncStock,salesRows,stockBlocks,checkHeaders}=require('../src/norma/workbook');
const {runNorma,loadConfig}=require('../src/norma/service');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'norma-test-'));const config={workbookPath:path.join(root,'stock.xlsx'),pendingDirectory:path.join(root,'Pending'),doneDirectory:path.join(root,'Done'),backupDirectory:path.join(root,'Backups'),reportDirectory:path.join(root,'Reports')};fs.writeFileSync(config.workbookPath,normaWorkbook());fs.mkdirSync(config.pendingDirectory);t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('norma-test-'));fs.rmSync(root,{recursive:true,force:true});});return {root,config};}
const invoice=()=>parseNormaText(normaText())[0];

test('new sales rows inherit date formatting even when styled blank cells already exist',()=>{
  const book=new Workbook(normaWorkbook());addInvoice(book,invoice());const sheet=book.sheet('Norma sales report Ggn.');sheet.cells.get('C2').setAttribute('s','13');
  sheet.number('C3',0);sheet.set('C3','');sheet.cells.get('C3').setAttribute('s','8');
  addInvoice(book,{...invoice(),invoiceNumber:'2620009999'});
  const saved=new Workbook(book.pack()).sheet('Norma sales report Ggn.');assert.equal(saved.value('C3'),String(book.serial('2026-11-10')));assert.equal(saved.cells.get('C3').getAttribute('s'),'13');assert.equal(saved.value('B3'),'2620009999');
});

test('saved workbook opens on the updated sheet with the new invoice row selected',()=>{
  for(const frozen of [false,true]){
    const book=new Workbook(normaWorkbook()),views=book.doc.createElementNS(NS,'bookViews'),view=book.doc.createElementNS(NS,'workbookView');view.setAttribute('activeTab','2');views.appendChild(view);book.doc.documentElement.insertBefore(views,elements(book.doc,'sheets')[0]);
    for(const sheet of book.sheets.values()){const views=sheet.doc.createElementNS(NS,'sheetViews'),view=sheet.doc.createElementNS(NS,'sheetView');view.setAttribute('workbookViewId','0');view.setAttribute('tabSelected','1');if(frozen){const pane=sheet.doc.createElementNS(NS,'pane');pane.setAttribute('state','frozen');pane.setAttribute('ySplit','1');view.appendChild(pane);const selected=sheet.doc.createElementNS(NS,'selection');selected.setAttribute('pane','bottomLeft');view.appendChild(selected);}views.appendChild(view);sheet.doc.documentElement.insertBefore(views,sheet.data);}
    book.focus('Norma sales report Smg',2565);const saved=new Workbook(book.pack());assert.equal(elements(saved.doc,'workbookView')[0].getAttribute('activeTab'),'1');const sheet=saved.sheet('Norma sales report Smg'),selectedView=elements(sheet.doc,'sheetView')[0];assert.equal(selectedView.getAttribute('tabSelected'),'1');assert.equal(elements(sheet.doc,'selection')[0].getAttribute('activeCell'),'B2565');assert.equal((frozen?elements(sheet.doc,'pane')[0]:selectedView).getAttribute('topLeftCell'),'A2555');assert.notEqual(elements(saved.sheet('Norma sales report Ggn.').doc,'sheetView')[0].getAttribute('tabSelected'),'1');
  }
});

test('complete stock tables have borders on empty receipts, transfers and Transit cells',()=>{
  const book=new Workbook(normaWorkbook());syncStock(book,{throughDate:'2026-11-10',extraParts:['13893M74L60']});
  const saved=new Workbook(book.pack()),sheet=saved.sheet('STOCK DETAILS');
  for(const region of ['gurgaon','gujarat']){
    const block=stockBlocks(sheet,region).find(b=>b.date==='2026-11-10');
    const first=region==='gurgaon'?65:73,last=region==='gurgaon'?71:79;
    for(let col=first;col<=last;col++){
      const letter=String.fromCharCode(col);assert.equal(sheet.cells.get(letter+(block.title+1)).getAttribute('s'),'2');
      for(const row of block.parts.values())assert.equal(sheet.cells.get(letter+row).getAttribute('s'),'1');
    }
    for(const row of block.parts.values())for(const col of region==='gurgaon'?['D','E']:['L','O'])assert.equal(sheet.value(col+row),'');
  }
  assert.equal(sheet.value('D3'),'100');assert.equal(sheet.value('E3'),'50');assert.equal(sheet.value('O3'),'500');
  assert.equal(sheet.cells.has('H'+stockBlocks(sheet,'gurgaon').find(b=>b.date==='2026-11-10').title),false);
});

test('Norma parser validates real printed amounts, ignores copies and rejects uncertain tables',()=>{
  const text=normaText();assert.equal(parseNormaText(text+'\n'+text.replace('ORIGINAL FOR BUYER','DUPLICATE FOR TRANSPORTER')).length,1);
  const doc=invoice();assert.equal(doc.plant,'MSILG');assert.equal(doc.items[0].normaPartNumber,'06281000050');assert.equal(doc.items[0].partNumber,'13892M74L60');assert.equal(doc.items[0].quantity,'250.000000');assert.equal(doc.items[0].total,'7554.94');
  assert.equal(parseNormaText(text+'\n'+normaText({number:'2620009999'}).replace('ORIGINAL FOR BUYER','DUPLICATE FOR TRANSPORTER')).length,2);
  for(const bad of [text.replace('250.00 pcs','251.00 pcs'),text.replace('7,554.94','7,555.94'),text.replace('13892M74L60','UNKNOWN'),text.replace('Gurgaon Plant','Unknown destination'),text.replace('10/11/2026','31/02/2026'),text.replace('9.00 576.22','8.00 576.22')])assert.throws(()=>parseNormaText(bad));
});

test('Norma workbook writes every sales column, keeps Srv blank, and rejects conflicting reruns',()=>{
  const book=new Workbook(normaWorkbook());checkHeaders(book);const doc=invoice();assert.equal(addInvoice(book,doc).status,'ADDED');const s=book.sheet('Norma sales report Ggn.');assert.equal(s.value('B2'),'2620008781');assert.equal(s.value('C2'),String(book.serial('2026-11-10')));assert.equal(s.value('E2'),'250');assert.equal(s.value('H2'),'');assert.equal(s.value('I2'),'6402.5');assert.equal(s.value('J2'),'576.22');assert.equal(s.value('K2'),'576.22');assert.equal(s.value('L2'),'7554.94');
  assert.equal(addInvoice(book,doc).status,'ALREADY_PRESENT');assert.throws(()=>addInvoice(book,{...doc,items:doc.items.map(i=>({...i,quantity:'500.000000'}))}),/conflict/);
  assert.throws(()=>addInvoice(book,{...doc,items:doc.items.map(i=>({...i,unitPrice:'99.000000'}))}),/conflict/);
  const next=new Workbook(book.pack());assert.equal(salesRows(next,'gurgaon').length,1);assert.equal(Buffer.from(next.files['custom/keep.xml']).toString(),'<unchanged>Unrelated workbook content</unchanged>');
});

test('Gujarat invoices populate IGST sales columns and Gujarat dispatch only',()=>{
  const book=new Workbook(normaWorkbook()),doc=invoice();const gujarat={...doc,invoiceNumber:'2620009998',plant:'SMG',region:'gujarat',items:doc.items.map(i=>({...i,cgst:'0.00',sgst:'0.00',igst:'1152.44'}))};
  addInvoice(book,gujarat);const sheet=book.sheet('Norma sales report Smg');assert.equal(sheet.value('J2'),'1152.44');assert.equal(sheet.value('K2'),'7554.94');assert.equal(sheet.value('L2'),'');assert.equal(sheet.value('H2'),'');
  syncStock(book,{throughDate:'2026-11-10',affected:{gujarat:['2026-11-10']}});const stock=book.sheet('STOCK DETAILS'),r=stockBlocks(stock,'gujarat').find(b=>b.date==='2026-11-10').parts.get('13892M74L60');assert.equal(stock.value('M'+r),'250');assert.equal(stock.value('N'+r),'1800');
  const g=stockBlocks(stock,'gurgaon').find(b=>b.date==='2026-11-10').parts.get('13892M74L60');assert.equal(stock.value('F'+g),'0');
});

test('repeated same-part invoice lines remain separate sales rows and sum once in stock',()=>{
  const book=new Workbook(normaWorkbook()),doc=invoice();doc.items.push({...doc.items[0]});addInvoice(book,doc);assert.equal(salesRows(book,'gurgaon').length,2);
  syncStock(book,{throughDate:'2026-11-10',affected:{gurgaon:['2026-11-10']}});const sheet=book.sheet('STOCK DETAILS'),row=stockBlocks(sheet,'gurgaon').find(b=>b.date==='2026-11-10').parts.get('13892M74L60');assert.equal(sheet.value('F'+row),'500');assert.equal(addInvoice(book,doc).status,'ALREADY_PRESENT');
});

test('stock carries previous balances, uses region sales quantities, and preserves manual movements',()=>{
  const book=new Workbook(normaWorkbook());addInvoice(book,invoice());const result=syncStock(book,{throughDate:'2026-11-11',affected:{gurgaon:['2026-11-10']},extraParts:['18526M86J20']});assert.ok(result.createdDays>=4);
  let sheet=book.sheet('STOCK DETAILS'),blocks=stockBlocks(sheet,'gurgaon');const tenth=blocks.find(b=>b.date==='2026-11-10'),eleventh=blocks.find(b=>b.date==='2026-11-11'),r=tenth.parts.get('13892M74L60'),n=eleventh.parts.get('13892M74L60');assert.equal(sheet.value('C'+r),'950');assert.equal(sheet.value('F'+r),'250');assert.equal(sheet.value('G'+r),'700');assert.equal(sheet.value('C'+n),'700');assert.equal(sheet.value('G'+n),'700');assert.equal(sheet.value('D3'),'100');assert.equal(sheet.value('E3'),'50');assert.equal(sheet.value('O3'),'500');assert.equal(sheet.value('C'+tenth.parts.get('18526M86J20')),'0');
  const guj=stockBlocks(sheet,'gujarat').find(b=>b.date==='2026-11-10');assert.equal(sheet.value('K'+guj.parts.get('13892M74L60')),'2050');assert.equal(sheet.value('M'+guj.parts.get('13892M74L60')),'0');
  sheet.number('D'+r,100);sheet.number('E'+r,25);syncStock(book,{throughDate:'2026-11-11',affected:{gurgaon:['2026-11-10']}});assert.equal(sheet.value('G'+r),'775');assert.equal(sheet.value('C'+n),'775');
});

test('Norma commits before archiving and recovers from a move failure without duplicate dispatches',async t=>{
  const {config}=fixture(t),file=path.join(config.pendingDirectory,'invoice.pdf');fs.writeFileSync(file,'test PDF bytes');let report=await runNorma(config,{throughDate:'2026-11-10',parsePdf:async()=>[invoice()],archive:()=>{throw Error('Done folder unavailable');},log:()=>{}});assert.equal(report.errors.length,1);assert.ok(fs.existsSync(file));assert.equal(salesRows(new Workbook(fs.readFileSync(config.workbookPath)),'gurgaon').length,1);assert.ok(report.backups.length);
  report=await runNorma(config,{throughDate:'2026-11-10',parsePdf:async()=>[invoice()],log:()=>{}});assert.equal(report.errors.length,0);assert.equal(report.files[0].sales[0].status,'ALREADY_PRESENT');assert.equal(report.backups.length,0);assert.ok(!fs.existsSync(file));assert.equal(fs.readFileSync(path.join(config.doneDirectory,'invoice.pdf'),'utf8'),'test PDF bytes');
});

test('failed parses and Excel locks keep PDFs in Pending and leave workbook unchanged',async t=>{
  const {config}=fixture(t),file=path.join(config.pendingDirectory,'bad.pdf');fs.writeFileSync(file,'broken');const before=fs.readFileSync(config.workbookPath);
  let report=await runNorma(config,{throughDate:'2026-11-10',parsePdf:async()=>{throw Error('Invalid table');},log:()=>{}});assert.equal(report.errors.length,1);assert.deepEqual(fs.readFileSync(config.workbookPath),before);assert.ok(fs.existsSync(file));
  fs.writeFileSync(path.join(path.dirname(config.workbookPath),'~$stock.xlsx'),'Excel owner');report=await runNorma(config,{throughDate:'2026-11-10',parsePdf:async()=>[invoice()],log:()=>{}});assert.match(report.errors[0].error,/Close.*Excel/);assert.deepEqual(fs.readFileSync(config.workbookPath),before);assert.ok(fs.existsSync(file));
});

test('Norma config rejects overlapping Pending and Done directories',t=>{const {root,config}=fixture(t),file=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify({...config,doneDirectory:config.pendingDirectory}));assert.throws(()=>loadConfig(file),/non-nested/);});

test('all six supplied Norma samples map to their correct workbook regions',async t=>{
  const examples=[['MNSR OES','2620008117','MSILM OES'],['GGN','2620008781','MSILG'],['GGN SPD','2620008716','MSILG SPD'],['SMG','2620008775','SMG'],['MSILK','2620008806','MSILK'],['MNSR V','2620008793','MSILM']];let count=0;for(const [name,number,plant] of examples){const file='C:/Users/DELL/Downloads/'+name+'.pdf';if(!fs.existsSync(file))continue;count++;const docs=await parseNormaPdf(fs.readFileSync(file));assert.equal(docs.length,1);assert.equal(docs[0].invoiceNumber,number);assert.equal(docs[0].plant,plant);}if(!count)t.skip('Supplied Norma PDFs unavailable');
});
