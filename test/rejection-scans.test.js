const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const {PDFDocument}=require('pdf-lib');
const {parsePage,readPages}=require('../src/rejections/parser');
const {tsvItems}=require('../src/rejections/pageOcr');
function scannedPage(number=1){
  const item=(text,x,y,w=.03)=>({text,x,y,w});
  return {page:number,textSource:'scanned-page-ocr',items:[
    item('Tax Invoice',.4,.05),item('(Against Rejection)',.4,.07),
    item('PLOT NO 1 IMT MANE SAR',.3,.22,.25),item('GURGAON-122051',.3,.24,.15),
    item('HE',.15,.27),item('100000000'+number,.18,.27,.08),item('DATE:',.4,.27),item('27-0ct-2026',.47,.27,.11),
    item('QTY',.38,.42),item('Basic',.415,.42),item('Taxable',.475,.42),item('Basic',.53,.42),item('Packing',.57,.42),item('CGST',.73,.42),item('sSGST',.78,.42),item('(Basic',.825,.422),item('TCS',.87,.42),
    item('12221M81R10-300',.16,.465,.09),item('2.00',.385,.478),item('|',.404,.478),item('5.00',.424,.483),item('5.50',.48,.483),item('10.00',.533,.483),item('1.00',.579,.483),item('0.99',.732,.475),item('|',.762,.475),item('0.99',.78,.475),item('1298',.826,.483)
  ],alternativeItems:[item('Grand',.2,.53)]};
}
test('scanned HE invoices support split invoice IDs, Manesar plant and original table values',()=>{
  const parsed=parsePage(scannedPage()),row=parsed.rows[0];
  assert.equal(row['Invoice Number'],'HE1000000001');assert.equal(row['Invoice Date'],'27.10.2026');
  assert.equal(row['Item Name'],'12221M81R10-300');assert.equal(row['PART NAME'],'F01948FG0000');
  assert.equal(row['Location(Plant)'],'Manesar(MF03)');assert.equal(row['Cust. Code'],'MFCM0MF03');
  assert.equal(row.Qty,'2');assert.equal(row['Basic value'],'10.00');assert.equal(row['Packing charges'],'1.00');
  assert.equal(row['CGST Amt.'],'0.99');assert.equal(row['SGST Amt.'],'0.99');assert.equal(row['Total Value'],'12.98');
  assert.equal(row['Ack. No'],'');assert.ok(parsed.issues.some(i=>/decimal separator/.test(i)));
  const wrong=scannedPage();wrong.items.find(i=>i.text==='1298').text='1300';
  assert.equal(parsePage(wrong).rows[0]['Total Value'],'');
});
test('full-page OCR word boxes map to normalized bottom-baseline coordinates',()=>{
  const tsv='level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t100\t200\t50\t20\t94\tPacking\n';
  assert.deepEqual(tsvItems(tsv,1000,2000),[{text:'Packing',x:.1,y:.11,w:.05,confidence:94}]);
});

test('scanned quantities with missing decimal separators produce a review row without guessing digits',()=>{
  const page=scannedPage();page.items.find(i=>i.text==='2.00').text='200';
  const parsed=parsePage(page);
  assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0].Qty,'');
  assert.ok(parsed.fieldRegions[0].Qty);assert.ok(parsed.issues.some(i=>/quantity left blank/.test(i)));
});

test('scanned corrections require independent field agreement and preserve reconciliation and invoice identity',()=>{
  const {compareFields,applyComparison}=require('../src/rejections/ocr');
  const parsed=parsePage(scannedPage());const row=parsed.rows[0];
  const read=(a,b=a,confidence=95)=>({windows:{text:a},tesseract:{text:b,confidence}});
  const comparisons=compareFields(row,{
    'Invoice Number':read('HE1000000099'),
    'Item Name':read('12221M72R00-300'),
    'Qty':read('3'),
    'Basic value':read('15.00'),
    'Packing charges':read('2.00','3.00'),
    'CGST Amt.':read('2.00','2.00',45)
  }).map(c=>({...c,line:1}));
  applyComparison(parsed,comparisons);
  assert.equal(row['Invoice Number'],'HE1000000001');
  assert.equal(row['Item Name'],'12221M72R00-300');assert.equal(row['PART NAME'],'F01906FG0000');
  assert.equal(row.Qty,'3');assert.equal(row['Basic value'],'15.00');
  assert.equal(row['Packing charges'],'1.00');assert.equal(row['CGST Amt.'],'0.99');
  assert.equal(row['Total Value'],'');
  assert.equal(comparisons.find(c=>c.field==='Basic value').pdf_value,'10.00');
  assert.ok(parsed.issues.some(i=>/total did not reconcile/.test(i)));
});
test('OCR agreement cannot publish a quantity with a lost decimal when the unit-price check fails',()=>{
  const {compareFields,applyComparison}=require('../src/rejections/ocr');
  const parsed=parsePage(scannedPage()),row=parsed.rows[0];
  const results=compareFields(row,{'Qty':{windows:{text:'200'},tesseract:{text:'200',confidence:96}}}).map(c=>({...c,line:1}));
  applyComparison(parsed,results);
  assert.equal(parsed.sourceFields[0].unitPrice,'5.00');assert.equal(row.Qty,'');
  assert.ok(parsed.issues.some(i=>/quantity does not match/.test(i)));
});

test('every image-only page gets OCR and one OCR failure does not drop the rest of the PDF',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rejection-scans-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pdf=await PDFDocument.create();for(let n=0;n<3;n++)pdf.addPage();
  const file=path.join(dir,'scanned.pdf');fs.writeFileSync(file,await pdf.save());
  const calls=[];let closed=0;
  const pages=await readPages(file,{ocrFactory:()=>({read:async page=>{calls.push(page);if(page===2)throw Error('OCR engine unavailable');return scannedPage(page);},close:async()=>{closed++;}})});
  assert.deepEqual(calls,[1,2,3]);assert.equal(closed,1);assert.equal(pages.length,3);
  assert.equal(parsePage(pages[0]).invoiceNumber,'HE1000000001');
  assert.throws(()=>parsePage(pages[1]),/OCR engine unavailable/);
  assert.equal(parsePage(pages[2]).invoiceNumber,'HE1000000003');
});
