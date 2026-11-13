const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const {PDFParse}=require('pdf-parse');
const {normalizePdfText}=require('../src/pdf/normalizePdfText');
const {processText,processPdf}=require('../src/services/invoiceProcessingService');
const {selectOriginalPages}=require('../src/pdf/originalPages');
const {validateGstin}=require('../src/pdf/validators/gstinValidator');

function multiRowFixture({secondPart='PART200',quantities=['2','1'],descriptions=['EXAMPLE CAMSHAFT A','EXAMPLE CAMSHAFT B']}={}){
  const gstin=base=>'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c=>base+c).find(validateGstin);
  return `EXAMPLE BUYER LTD\tName :
${gstin('06PQRST5678K1Z')}
1
2
Sr # Description of Goods
${quantities.join('\n')}
Qty
10.00
10.00
Rate
per Unit
20.00
10.00
9
9
Rate%
1.80
.90
Amt.
9
9
1.80
.90
0
0
.00
.00
Our GSTIN Number ${gstin('06ABCDE1234F1Z')}
HSN/
SAC
73259910
73259910
Unit
NOS
NOS
Taxable
Value
${descriptions.join('\n')}
EXAMPLE ROAD
EXAMPLE CITY
Address :
TAX INVOICE
6202600001
05-NOV-26
MAHLE ENGINE COMPONENTS INDIA PVT. LTD.
Invoice Serial Number:
Total Invoice Value (In Words)
35.40
30.00 Total: 2.70 2.70 .00
PART NO PART100
PART NO ${secondPart}`;
}

test('MAHLE column-wise multi-row tables extract each part and reconcile all quantities and taxes',()=>{
  const doc=processText(multiRowFixture());assert.equal(doc.validation.status,'VALIDATED',JSON.stringify(doc.validation.issues));
  assert.equal(doc.lineItems.length,2);
  assert.deepEqual(doc.lineItems.map(i=>[i.lineNumber,i.partNumber,i.quantity,i.taxableAmount,i.cgst,i.sgst,i.igst]),[[1,'PART100','2.000000','20.00','1.80','1.80','0.00'],[2,'PART200','1.000000','10.00','0.90','0.90','0.00']]);
  const repeated=processText(multiRowFixture({secondPart:'PART100'}));assert.equal(repeated.validation.status,'VALIDATED');assert.equal(repeated.lineItems.length,2);
  assert.deepEqual(repeated.lineItems.map(i=>i.partNumber),['PART100','PART100']);
});

test('MAHLE multi-row parsing rejects incomplete columns and unsupported wrapped descriptions',()=>{
  for(const source of [multiRowFixture({quantities:['2']}),multiRowFixture({descriptions:['EXAMPLE CAMSHAFT A','WRAPPED DESCRIPTION','EXAMPLE CAMSHAFT B']}),multiRowFixture().replace('PART NO PART200','')]){
    const doc=processText(source);assert.equal(doc.validation.status,'NEEDS_REVIEW');assert.deepEqual(doc.lineItems,[]);
  }
});

test('MAHLE wrapped camshaft direction belongs to the existing item row',()=>{
  for(const direction of ['(INTAKE)','EXHAUST']){
    const description='CAMSHAFT CASTING K12VVT';
    const doc=processText(multiRowFixture({descriptions:[description,direction,description,direction]}));
    assert.equal(doc.validation.status,'VALIDATED',JSON.stringify(doc.validation.issues));
    assert.equal(doc.lineItems.length,2);
    assert.deepEqual(doc.lineItems.map(i=>i.description),[description+' '+direction,description+' '+direction]);
    assert.deepEqual(doc.lineItems.map(i=>i.quantity),['2.000000','1.000000']);
  }
});

test('multi-row financial mismatches remain visible instead of adjusting PDF values to force validation',()=>{
  const doc=processText(multiRowFixture({quantities:['3','1']}));assert.equal(doc.lineItems[0].quantity,'3.000000');
  assert.equal(doc.validation.status,'NEEDS_REVIEW');assert.ok(doc.validation.issues.some(i=>i.field==='lineItems.0'));
});

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
