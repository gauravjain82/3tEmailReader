const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const {extractEwayBill}=require('../src/pdf/extractEwayBill');
const {processText,processPdf}=require('../src/services/invoiceProcessingService');

test('e-way bills require a labeled full number and deduplicate repeated copies',()=>{
  for(const label of ['E-Way Bill No:', 'eWAY Bill No. :', 'E Way Bill Number', 'EWB No.']) {
    assert.equal(extractEwayBill(label+'\n372375307838').ewayBillNumber,'372375307838');
  }
  assert.equal(extractEwayBill('EWB: 372375307838\nEWB: 372375307838').ewayBillNumber,'372375307838');
  for(const text of ['Invoice No: 372375307838','EWB: 12345678901','EWB: 1234567890123','EWB: 372375307838X','E-Way Bill No: N/A\nInvoice No: 372375307838']) assert.equal(extractEwayBill(text).ewayBillNumber,null);
  const conflict=processText('Tax Invoice\nEWB: 372375307838\nEWB: 342371494669');
  assert.equal(conflict.ewayBillNumber,null);
  assert.ok(conflict.validation.issues.some(i=>i.field==='ewayBillNumber'));
});

test('MAHLE separated declaration values require the known heading on the same page',()=>{
  const text='MAHLE ENGINE COMPONENTS INDIA\nDeclaration E-Way Bill No: Date\nTotal: 100.00\nNo of\nBox\n1\n372375307838 10-NOV-26';
  assert.equal(extractEwayBill(text).ewayBillNumber,'372375307838');
  assert.equal(extractEwayBill(text.replace('MAHLE ENGINE COMPONENTS INDIA','OTHER VENDOR')).ewayBillNumber,null);
  assert.equal(extractEwayBill(text.replace('372375307838','-- 1 of 2 --\n372375307838')).ewayBillNumber,null);
  assert.equal(extractEwayBill(text+'\n342371494669 03-NOV-26').ewayBillNumber,null);
});

test('supplied MAHLE PDF extracts its printed e-way bill number',async t=>{
  const file='C:/Users/DELL/Downloads/6202602197_1_SIGNED.pdf';
  if(!fs.existsSync(file))return t.skip('Supplied PDF unavailable');
  const doc=await processPdf(fs.readFileSync(file));
  assert.equal(doc.ewayBillNumber,'372375307838');
  assert.equal(doc.validation.status,'VALIDATED');
});
