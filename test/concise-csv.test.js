const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {extractIrn}=require('../src/pdf/extractIrn');
const {processText}=require('../src/services/invoiceProcessingService');
const {openStore}=require('../src/storage/store');
const {combineInvoiceParts}=require('../src/storage/combineInvoiceParts');
const irn='0123456789abcdef'.repeat(4);

test('CSV combines matching parts within one invoice and preserves source rows',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-csv-test-'));const store=openStore(dir);
  t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-csv-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  const doc=processText('Tax Invoice\nInvoice No: 6202602197\nInvoice Date: 10/11/2026');
  doc.lineItems=[{partNumber:'12711M81R10-300',quantity:'200.000000',taxableAmount:'80976.00'},{partNumber:'OTHER123',quantity:'0.100001',taxableAmount:'0.10'},{partNumber:'12711M81R10-300',quantity:'200.000000',taxableAmount:'80976.00'}];
  const row=store.save({gmail_id:'one',attachment_key:'a',filename:'mahle.pdf'},doc);
  store.save({gmail_id:'two',attachment_key:'a',filename:'other.pdf'},{...doc,invoiceNumber:'6202602198',lineItems:[doc.lineItems[0]]});
  store.exportAll();
  const csv=fs.readFileSync(path.join(dir,'invoices.csv'),'utf8').trim().split('\r\n');
  assert.deepEqual(csv.slice(1),['6202602197,2026-11-10,12711M81R10-300,400,161952.00,,,','6202602197,2026-11-10,OTHER123,0.100001,0.10,,,','6202602198,2026-11-10,12711M81R10-300,200,80976.00,,,']);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM invoice_line_items WHERE invoice_id=?').get(row.id).n,3);
  store.exportAll();assert.equal(fs.readFileSync(path.join(dir,'invoices.csv'),'utf8').trim(),csv.join('\r\n'));
});

test('part totals use exact decimals and keep missing values unknown',()=>{
  const item=(part_number,quantity,taxable_amount)=>({part_number,quantity,taxable_amount});
  const rows=combineInvoiceParts([item('A','0.100001','0.10'),item('A','0.200002','0.20'),item('B',null,'1.00'),item('B','2',null),item(null,'1','1.00'),item(null,'2','2.00')]);
  assert.deepEqual(rows.slice(0,2),[item('A','0.300003','0.30'),item('B',null,null)]);
  assert.equal(rows.length,4);
});
test('IRN supports labeled single-line, wrapped, repeated and conflicting references',()=>{
  assert.equal(extractIrn('IRN No. : '+irn).irn,irn);
  assert.equal(extractIrn('IRN:\n'+irn.slice(0,24)+'\n'+irn.slice(24,48)+'\n'+irn.slice(48)).irn,irn);
  assert.equal(extractIrn('IRN: '+irn+'\nIRN No: '+irn).irn,irn);
  for(const value of ['GSTIN',irn.slice(1),irn+'0',irn.slice(0,63)+'G'])assert.equal(extractIrn('IRN: '+value).irn,null);
  const conflict=extractIrn('IRN: '+irn+'\nIRN: '+'a'.repeat(64));assert.equal(conflict.irn,null);assert.equal(conflict.irnCandidates.length,2);
  assert.ok(processText('Tax Invoice\nInvoice No: INV001\nIRN: '+irn+'\nIRN: '+'a'.repeat(64)).validation.issues.some(i=>i.field==='irn'));
});
test('CSV includes the email subject on each item and omits duplicate and logistics records',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-csv-test-'));const store=openStore(dir);
  t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-csv-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  const doc=processText('Tax Invoice\nInvoice No: INV001\nInvoice Date: 26/10/2026\nE-Way Bill No: 372375307838\nIRN No: '+irn);
  doc.lineItems=[{partNumber:'PART001',quantity:'200.000000',taxableAmount:'32920.00'},{partNumber:'PART002',quantity:'2.500000',taxableAmount:'12.50'}];
  const meta=id=>({gmail_id:id,attachment_key:'a',filename:'invoice.pdf',subject:'Invoices, "November"'});
  const row=store.save(meta('original'),doc);store.save(meta('duplicate'),doc);store.save(meta('bin'),processText('Bin No 1 QTY/BIN 10'));
  store.exportAll();
  const csv=fs.readFileSync(path.join(dir,'invoices.csv'),'utf8').trim().split('\r\n');
  assert.deepEqual(csv,['invoice_number,invoice_date,part_number,quantity,taxable_amount,IRN No,email_subject,E-Way Bill No',`INV001,2026-10-26,PART001,200,32920.00,${irn},"Invoices, ""November""",372375307838`,`INV001,2026-10-26,PART002,2.5,12.50,${irn},"Invoices, ""November""",372375307838`]);
  assert.equal(store.db.prepare('SELECT irn FROM invoices WHERE id=?').get(row.id).irn,irn);
  store.save(meta('original'),{...doc,irn:null},{reprocess:true});assert.equal(store.db.prepare('SELECT irn FROM invoices WHERE id=?').get(row.id).irn,irn);
  assert.equal(store.db.prepare('SELECT eway_bill_number FROM invoices WHERE id=?').get(row.id).eway_bill_number,'372375307838');
  store.save(meta('original'),{...doc,ewayBillNumber:null},{reprocess:true});
  assert.equal(store.db.prepare('SELECT eway_bill_number FROM invoices WHERE id=?').get(row.id).eway_bill_number,'372375307838');
  store.exportAll();assert.equal(JSON.parse(fs.readFileSync(row.json_path,'utf8')).ewayBillNumber,'372375307838');
  store.save(meta('original'),{...doc,ewayBillNumber:null,ewayBillCandidates:['372375307838','342371494669']},{reprocess:true});
  assert.equal(store.db.prepare('SELECT eway_bill_number FROM invoices WHERE id=?').get(row.id).eway_bill_number,null);
});
test('failure report includes validation issues and downloads without invoice rows, and excludes successful records',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-csv-test-'));const store=openStore(dir);
  t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-csv-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  const review=processText('Tax Invoice\nInvoice No: REVIEW001');
  store.save({gmail_id:'review',attachment_key:'a',filename:'needs-review.pdf'},review);
  store.save({gmail_id:'ok',attachment_key:'a',filename:'passed.pdf'},{...review,invoiceNumber:'OK002',validation:{status:'VALIDATED',issues:[],checks:[]}});
  store.markAttachment({gmail_id:'download',attachment_key:'a',filename:'download-failed.pdf'},'failed','Download interrupted');
  store.exportAll();
  const report=fs.readFileSync(path.join(dir,'failure-report.csv'),'utf8');
  assert.match(report,/needs-review.pdf,REVIEW001,NEEDS_REVIEW/);assert.match(report,/invoiceDate: Missing or invalid calendar date/);
  assert.match(report,/download-failed.pdf,,FAILED,Download interrupted/);assert.doesNotMatch(report,/passed.pdf/);
});
