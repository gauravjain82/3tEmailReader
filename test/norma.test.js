const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),os=require('os'),path=require('path');
const {normaWorkbook,normaText}=require('./helpers/normaFixture');
const {parseNormaText,parseNormaPdf}=require('../src/norma/parser');const {Workbook,NS,elements}=require('../src/norma/xlsx');
const {addInvoice,syncStock,salesRows,stockBlocks,checkHeaders,latestClosing}=require('../src/norma/workbook');
const {runNorma,loadConfig}=require('../src/norma/service');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'norma-test-'));const config={workbookPath:path.join(root,'stock.xlsx'),pendingDirectory:path.join(root,'Pending'),doneDirectory:path.join(root,'Done'),backupDirectory:path.join(root,'Backups'),reportDirectory:path.join(root,'Reports')};fs.writeFileSync(config.workbookPath,normaWorkbook());fs.mkdirSync(config.pendingDirectory);t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('norma-test-'));fs.rmSync(root,{recursive:true,force:true});});return {root,config};}
const invoice=()=>parseNormaText(normaText())[0];

function latestEntryBook(region='gurgaon',closing=825){
  const book=new Workbook(normaWorkbook()),s=book.sheet('STOCK DETAILS');
  const c=region==='gurgaon'?{part:'B',opening:'C',received:'D',transfer:'E',dispatch:'F',balance:'G',name:'Gurgaon'}:{part:'J',opening:'K',received:'L',dispatch:'M',balance:'N',name:'Gujarat'};
  s.set(c.part+'1276','Norma '+c.name+' 18.11.2026 opening');s.set(c.part+'1277','Part No.');s.set(c.part+'1278','13892M74L60');s.number(c.opening+'1278',99999,{formula:'#REF!'});s.number(c.received+'1278',100);if(c.transfer)s.number(c.transfer+'1278',25);s.number(c.dispatch+'1278',200);s.number(c.balance+'1278',closing);return {book,s,c};
}

function closingError(sheet,ref,formula){sheet.number(ref,0,{formula});const cell=sheet.cells.get(ref);cell.setAttribute('t','e');elements(cell,'v')[0].textContent='#REF!';}

test('broken latest opening is recovered by replaying receipts, transfers and recorded dispatch',()=>{
  const {book,s}=latestEntryBook();closingError(s,'G1278','C1278+D1278-E1278-F1278');const result=syncStock(book,{throughDate:'2026-11-19'});
  assert.equal(s.value('C1278'),'950');assert.equal(s.formula('C1278'),'');assert.equal(s.value('G1278'),'825');assert.equal(s.value('D1278'),'100');assert.equal(s.value('E1278'),'25');assert.equal(s.value('F1278'),'200');assert.equal(result.recoveries[0].basis,'previous-valid-closing');assert.equal(result.recoveries[0].quantity,825);
  const row=stockBlocks(s,'gurgaon').find(b=>b.date==='2026-11-19').parts.get('13892M74L60');assert.equal(s.value('C'+row),'825');
});

test('recovery includes sales on missing stock days rather than skipping their dispatch',()=>{
  const {book,s}=latestEntryBook();closingError(s,'G1278','C1278+D1278-E1278-F1278');addInvoice(book,{...invoice(),date:'2026-11-17'});
  const result=syncStock(book,{throughDate:'2026-11-19'});assert.equal(s.value('C1278'),'700');assert.equal(s.value('G1278'),'575');const step=result.recoveries[0].steps.find(s=>s.date==='2026-11-17');assert.equal(step.dispatch,250);assert.equal(step.dispatchSource,'sales-sheet');
});

test('a new part recovers from zero or configured opening while preserving its movements',()=>{
  for(const [opening,basis] of [[0,'new-part-zero-opening'],[500,'configured-new-part-opening']]){
    const {book,s}=latestEntryBook('gujarat');s.set('J1278','13894M74L50');closingError(s,'N1278','K1278+L1278-M1278');const openingBalances=opening?{gujarat:{'13894M74L50':opening}}:{};const result=syncStock(book,{throughDate:'2026-11-19',openingBalances});assert.equal(s.value('K1278'),String(opening));assert.equal(s.value('N1278'),String(opening-100));assert.equal(result.recoveries.find(r=>r.partNumber==='13894M74L50').basis,basis);
  }
});

test('recovery refuses unknown adjustments and parts with earlier sales but no verified opening',()=>{
  const partial=latestEntryBook();partial.s.number('C1278',0,{formula:'#REF!+50'});closingError(partial.s,'G1278','C1278+D1278-E1278-F1278');assert.throws(()=>syncStock(partial.book,{throughDate:'2026-11-19'}),/Latest stock entry/);assert.equal(partial.s.formula('C1278'),'#REF!+50');
  const receipts=latestEntryBook();closingError(receipts.s,'G1278','C1278+D1278-E1278-F1278');receipts.s.number('D1278',0,{formula:'#REF!'});assert.throws(()=>syncStock(receipts.book,{throughDate:'2026-11-19'}),/D1278/);assert.equal(receipts.s.formula('C1278'),'#REF!');
  const existing=latestEntryBook('gujarat');existing.s.set('J1278','13894M74L50');closingError(existing.s,'N1278','K1278+L1278-M1278');const doc=invoice();addInvoice(existing.book,{...doc,date:'2026-11-17',region:'gujarat',plant:'SMG',items:doc.items.map(i=>({...i,partNumber:'13894M74L50',cgst:'0.00',sgst:'0.00',igst:'1152.44'}))});assert.throws(()=>syncStock(existing.book,{throughDate:'2026-11-19'}),/Latest stock entry/);
});

test('supplied original client workbook processes the PDF with automatic recovery and a backup',async t=>{
  const source='C:/Users/DELL/Downloads/Norma.xlsx',pdf='C:/Users/DELL/Downloads/SalesInvoiceNGT-ext05955-97053_19112026_134158_890_97665_P.pdf';if(!fs.existsSync(source)||!fs.existsSync(pdf))return t.skip('Client workbook/PDF unavailable');const original=fs.readFileSync(source),input=new Workbook(original);if(input.sheet('STOCK DETAILS').formula('C1278')!=='#REF!'||input.sheet('STOCK DETAILS').formula('K1278')!=='#REF!')return t.skip('Client workbook no longer contains reported broken entries');
  const {config}=fixture(t);fs.writeFileSync(config.workbookPath,original);fs.copyFileSync(pdf,path.join(config.pendingDirectory,'invoice.pdf'));const report=await runNorma(config,{throughDate:'2026-11-19',log:()=>{}});assert.deepEqual(report.errors,[]);assert.equal(report.files[0].status,'DONE');assert.equal(report.files[0].stock.recoveries.length,2);assert.equal(report.files[0].stock.recoveries.find(r=>r.region==='gujarat').basis,'new-part-zero-opening');assert.deepEqual(fs.readFileSync(report.backups[0]),original);const saved=new Workbook(fs.readFileSync(config.workbookPath));assert.equal(saved.sheet('STOCK DETAILS').value('C1278'),'0');assert.equal(saved.sheet('STOCK DETAILS').value('K1278'),'0');assert.ok(salesRows(saved,'gurgaon').some(r=>r.number==='2620009051'));assert.deepEqual(fs.readFileSync(source),original);
});

test('opening uses latest saved part closing without following old opening-cell references',()=>{
  const {book,s}=latestEntryBook();const result=syncStock(book,{throughDate:'2026-11-19'});
  const row=stockBlocks(s,'gurgaon').find(b=>b.date==='2026-11-19').parts.get('13892M74L60');
  assert.equal(s.value('C'+row),'825');assert.equal(s.formula('C'+row),'');assert.equal(s.formula('C1278'),'#REF!');assert.equal(s.value('D1278'),'100');assert.equal(s.value('E1278'),'25');
  const source=result.openingSources.find(s=>s.region==='gurgaon'&&s.partNumber==='13892M74L60');assert.equal(source.sourceDate,'2026-11-18');assert.equal(source.sourceCell,'G1278');assert.equal(source.quantity,825);
});

test('Gujarat independently carries a verified zero from its latest entry',()=>{
  const {book,s}=latestEntryBook('gujarat',0);s.number('N3',10000);const result=syncStock(book,{throughDate:'2026-11-19'});const row=stockBlocks(s,'gujarat').find(b=>b.date==='2026-11-19').parts.get('13892M74L60');assert.equal(s.value('K'+row),'0');assert.equal(s.formula('K'+row),'');assert.equal(result.openingSources.find(s=>s.region==='gujarat').quantity,0);
});

test('each part keeps its own latest entry even when absent from the newest daily block',()=>{
  const {book,s}=latestEntryBook();s.set('B4','13893M74L60');s.number('G4',3000);syncStock(book,{throughDate:'2026-11-19'});
  const block=stockBlocks(s,'gurgaon').find(b=>b.date==='2026-11-19'),row=block.parts.get('13893M74L60');assert.ok(row);assert.equal(s.value('C'+row),'3000');assert.equal(s.formula('C'+row),'');
});

test('latest lookup matches dates and parts, excludes future entries and uses last same-date entry',()=>{
  const book=new Workbook(normaWorkbook()),s=book.sheet('STOCK DETAILS');
  for(const [title,date,value] of [[100,'18.11.2026',400],[200,'20.11.2026',99999],[300,'15.11.2026',600],[400,'18.11.2026',450]]){s.set('B'+title,'Norma Gurgaon '+date+' opening');s.set('B'+(title+2),'13892M74L60');s.number('G'+(title+2),value);}
  s.set('B403','13893M74L60');s.number('G403',7000);
  const blocks=stockBlocks(s,'gurgaon');const source=latestClosing(s,blocks,{region:'gurgaon',part:'13892M74L60',beforeDate:'2026-11-19'});assert.equal(source.quantity,450000000n);assert.equal(source.sourceCell,'G402');assert.equal(source.sourceDate,'2026-11-18');
  assert.equal(latestClosing(s,blocks,{region:'gurgaon',part:'13893M74L60',beforeDate:'2026-11-19'}).quantity,7000000000n);
  assert.equal(latestClosing(s,blocks,{region:'gurgaon',part:'18526M86J20',beforeDate:'2026-11-19'}),null);
  s.set('B404','13892M74L60');s.number('G404',475);assert.equal(latestClosing(s,stockBlocks(s,'gurgaon'),{region:'gurgaon',part:'13892M74L60',beforeDate:'2026-11-19'}).sourceCell,'G404');
  syncStock(book,{throughDate:'2026-11-19'});const current=stockBlocks(s,'gurgaon').find(b=>b.date==='2026-11-19').parts.get('13892M74L60');assert.equal(s.value('C'+current),'475');assert.equal(s.formula('C'+current),'');
});

test('rerunning a date reads the updated latest closing and does not subtract dispatch twice',()=>{
  const book=new Workbook(normaWorkbook()),s=book.sheet('STOCK DETAILS');addInvoice(book,invoice());syncStock(book,{throughDate:'2026-11-10'});const row=stockBlocks(s,'gurgaon').find(b=>b.date==='2026-11-10').parts.get('13892M74L60');assert.equal(s.value('G'+row),'700');
  syncStock(book,{throughDate:'2026-11-10'});assert.equal(s.value('G'+row),'700');s.number('G3',1200);syncStock(book,{throughDate:'2026-11-10'});assert.equal(s.value('C'+row),'1200');assert.equal(s.value('F'+row),'250');assert.equal(s.value('G'+row),'950');
});

test('invalid latest closing does not fall back to an older balance or numeric error cache',()=>{
  for(const corrupt of [s=>s.set('G1278',''),s=>s.set('G1278','#REF!'),s=>s.number('G1278',99999,{formula:'#REF!'}),s=>{s.number('G1278',950);s.cells.get('G1278').setAttribute('t','e');}]){
    const {book,s}=latestEntryBook();s.number('C1278',950);corrupt(s);assert.throws(()=>syncStock(book,{throughDate:'2026-11-19'}),/Latest stock entry.*2026-11-18.*G1278/);
  }
});

test('Norma saves latest-entry openings before archiving and records their source dates',async t=>{
  const {config}=fixture(t),{book}=latestEntryBook(),file=path.join(config.pendingDirectory,'invoice.pdf');fs.writeFileSync(config.workbookPath,book.pack());fs.writeFileSync(file,'PDF bytes');const doc={...invoice(),date:'2026-11-19'};
  const report=await runNorma(config,{throughDate:'2026-11-19',parsePdf:async()=>[doc],log:()=>{}});assert.equal(report.errors.length,0);assert.equal(report.files[0].status,'DONE');assert.ok(report.files[0].stock.openingSources.some(s=>s.sourceCell==='G1278'&&s.quantity===825));assert.ok(report.backups.length);
  const saved=new Workbook(fs.readFileSync(config.workbookPath)),sheet=saved.sheet('STOCK DETAILS'),row=stockBlocks(sheet,'gurgaon').find(b=>b.date==='2026-11-19').parts.get('13892M74L60');assert.equal(sheet.value('C'+row),'825');assert.equal(sheet.value('G'+row),'575');assert.equal(sheet.formula('C'+row),'');assert.equal(sheet.formula('C1278'),'#REF!');assert.equal(salesRows(saved,'gurgaon').length,1);assert.ok(fs.existsSync(path.join(config.doneDirectory,'invoice.pdf')));assert.equal(fs.existsSync(file),false);
});

test('invalid latest saved closing preserves workbook bytes and leaves the PDF in Pending',async t=>{
  const {config}=fixture(t),book=new Workbook(fs.readFileSync(config.workbookPath));book.sheet('STOCK DETAILS').number('G3',950,{formula:'#REF!'});fs.writeFileSync(config.workbookPath,book.pack());const original=fs.readFileSync(config.workbookPath),file=path.join(config.pendingDirectory,'invoice.pdf');fs.writeFileSync(file,'PDF test bytes');
  const report=await runNorma(config,{throughDate:'2026-11-10',parsePdf:async()=>[invoice()],log:()=>{}});assert.equal(report.errors.length,1);assert.match(report.errors[0].error,/Latest stock entry.*G3/);assert.deepEqual(fs.readFileSync(config.workbookPath),original);assert.equal(fs.existsSync(file),true);assert.equal(report.backups.length,0);
});

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
