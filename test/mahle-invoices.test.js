const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const {PDFParse}=require('pdf-parse');
const {normalizePdfText}=require('../src/pdf/normalizePdfText');
const {processText,processPdf}=require('../src/services/invoiceProcessingService');
const {selectOriginalPages}=require('../src/pdf/originalPages');

function encode(text) {return [...text].map(c=>c===' '?'\uF020':c.charCodeAt(0)>=33&&c.charCodeAt(0)<=127?String.fromCharCode(0xF000+0x120-c.charCodeAt(0)):c).join('');}
test('normalizes the verified MAHLE font mapping and leaves other fonts/text untouched',()=>{
  const plain='MAHLE ENGINE COMPONENTS INDIA PVT. LTD.\nTAX INVOICE\nInvoice Serial Number:\nOur GSTIN Number\n1234567890\nPART NO ABC123';
  assert.equal(normalizePdfText(encode(plain)),plain);
  assert.equal(normalizePdfText(plain),plain);
  const unrelated=encode('Unrelated symbol text '.repeat(10));assert.equal(normalizePdfText(unrelated),unrelated);
});
test('malformed/unsupported MAHLE layout requires review rather than fabricated item values',()=>{
  const doc=processText('MAHLE ENGINE COMPONENTS INDIA PVT. LTD.\nInvoice Serial Number:\nTAX INVOICE\n6202602000\n31-FEB-26\nPART NO ABC123\nPART NO XYZ456');
  assert.equal(doc.parserName,'mahle');assert.equal(doc.validation.status,'NEEDS_REVIEW');assert.deepEqual(doc.lineItems,[]);
  assert.ok(doc.validation.issues.some(i=>i.field==='invoiceDate'));
});
test('both supplied signed MAHLE PDFs extract distinct parts/IRNs and reconcile all amounts',async t=>{
  const examples=[
    ['6202602146_1_SIGNED.pdf','6202602146','12721M81R10-300','41c55a33415ae98368e613d8ad13e4ad2e5167f2d61054d64ab8d4bfb8a1c664'],
    ['6202602145_1_SIGNED.pdf','6202602145','12711M81R10-300','05486fa6195628fd4a3685f65bb8b42b85297d18818c2d9734b029b149dd2d7a']
  ];let available=0;
  for(const [filename,number,part,irn] of examples) {
    const file='C:/Users/DELL/Downloads/'+filename;if(!fs.existsSync(file))continue;available++;
    const bytes=fs.readFileSync(file);const doc=await processPdf(bytes);
    assert.equal(doc.parserName,'mahle');assert.equal(doc.invoiceNumber,number);assert.equal(doc.invoiceDate,'2026-11-03');assert.equal(doc.irn,irn);
    assert.equal(doc.lineItems.length,1);assert.equal(doc.lineItems[0].partNumber,part);assert.equal(doc.lineItems[0].quantity,'600.000000');assert.equal(doc.lineItems[0].taxableAmount,'242928.00');
    assert.equal(doc.totalAmount,'286655.04');assert.equal(doc.validation.status,'VALIDATED');
    const parser=new PDFParse({data:new Uint8Array(bytes)});try {assert.deepEqual(selectOriginalPages((await parser.getText()).pages,number),[0]);} finally {await parser.destroy();}
  }
  if(!available)t.skip('Supplied MAHLE PDFs are not available on this machine');
});
