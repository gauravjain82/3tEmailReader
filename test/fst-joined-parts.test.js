const test=require('node:test');
const assert=require('node:assert/strict');
const {fstInvoiceParser}=require('../src/pdf/parsers/fstInvoiceParser');
function fixture(part,description='0049486543 TCY 45,0X 56,0X 7,0',buyer='Maruti Suzuki India Limited'){
  const row=`1 ${description} ${part} 40169330 432 PC 31.45 1 13,586.00 9.00 1,223.00 9.00 1,223.00`;
  return `Freudenberg-NOK Pvt.Ltd.\nBilled to: 59511\n${buyer}\nShipped To:\n`+
    `Rate Amt Rate Amt\n${row}\nTotal Invoice Value\n`.repeat(3);
}
test('FST joined seal grade and Maruti customer part split without duplicating invoice copies',()=>{
  const doc=fstInvoiceParser(fixture('A43743446M80T00'));
  assert.equal(doc.lineItems.length,1);
  assert.equal(doc.lineItems[0].partNumber,'43446M80T00');
  assert.equal(doc.lineItems[0].description,'0049486543 TCY 45,0X 56,0X 7,0 A437');
  assert.equal(doc.lineItems[0].quantity,'432.000000');
  assert.equal(doc.lineItems[0].taxableAmount,'13586.00');
  assert.deepEqual(doc.partNumbers,['43446M80T00']);
});
test('FST spaced parts and unrelated part formats remain intact',()=>{
  assert.equal(fstInvoiceParser(fixture('43446M80T00','TCY 45,0X 56,0X 7,0 A437')).lineItems[0].partNumber,'43446M80T00');
  for(const part of ['A437OTHER123','43446M80T00','A43743446M80T00']){
    assert.equal(fstInvoiceParser(fixture(part,'OTHER DESCRIPTION')).lineItems[0].partNumber,part);
    assert.equal(fstInvoiceParser(fixture(part,undefined,'OTHER CUSTOMER')).lineItems[0].partNumber,part);
  }
});
test('FST rounded printed amounts are retained without recalculation',()=>{
  const text=fixture('A43743446M80T00')+'\nSubtotal 13,586.00\nCGST 1,223.00\nSGST 1,223.00\nGrand Total 16,032.00';
  const doc=fstInvoiceParser(text);
  assert.equal(doc.taxableAmount,'13586.00');
  assert.equal(doc.cgst,'1223.00');assert.equal(doc.sgst,'1223.00');assert.equal(doc.totalAmount,'16032.00');
  assert.equal(doc.lineItems[0].taxableAmount,'13586.00');
  assert.equal(doc.lineItems[0].cgst,'1223.00');
  assert.equal(doc.amountBasis,undefined);
});
