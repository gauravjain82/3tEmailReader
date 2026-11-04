const {test}=require('node:test');
const assert=require('node:assert/strict');
const {extractItemName,partNameForItem,plantForLocation}=require('../src/rejections/mappings');
const {parsePage}=require('../src/rejections/parser');
const {compareFields}=require('../src/rejections/ocr');
const pages=require('./fixtures/rejections/mf02-pages.json');
const pairs=[['12221M81R10-300','F01948FG0000'],['12221M72R00-300','F01906FG0000'],['12221M68PC0-300','F01904FG0000'],['12221M78431-300','F01013FG0000'],['12221M79G00-300','F01474FG0000'],['12221M86J00-300','F91637FG0000']];
function withPart(code){
  const page=structuredClone(pages[0]);
  const token=page.items.find(i=>i.text==='12221M72ROO-');assert.ok(token);
  token.text=code.slice(0,-3);return page;
}
test('all supplied item numbers including alphanumeric bodies are parsed and mapped',()=>{
  for(const [item,part] of pairs){
    assert.equal(extractItemName(item),item);assert.equal(partNameForItem(item),part);
    const row=parsePage(withPart(item)).rows[0];assert.equal(row['Item Name'],item);assert.equal(row['PART NAME'],part);
  }
  assert.equal(extractItemName('1222 1M68PC0 300'),'12221M68PC0-300');
});
test('an unmapped item keeps PART NAME empty and preserves the PDF description only as source detail',()=>{
  const page=withPart('12221MZZZ99-300'),parsed=parsePage(page);
  assert.equal(parsed.rows[0]['PART NAME'],'');assert.equal(parsed.rows[0]['Item Name'],'12221MZZZ99-300');
  assert.equal(parsed.sourceFields[0].itemDescription,'CRANKSHAFT RM KBKC');
  assert.equal(partNameForItem('not-listed'),'');
});
test('plant/customer mapping uses the supplier location and handles unknown or ambiguous locations without a default',()=>{
  assert.deepEqual(plantForLocation('gurgaon 122015'),{location:'Gurgaon(MF02)',customerCode:'MFCM0MF02'});
  assert.deepEqual(plantForLocation('MANESAR 122050'),{location:'Manesar(MF03)',customerCode:'MFCM0MF03'});
  const manesar=structuredClone(pages[0]);
  for(const item of manesar.items)if(item.text==='GURGAON')item.text='MANESAR';
  const row=parsePage(manesar).rows[0];assert.equal(row['Location(Plant)'],'Manesar(MF03)');assert.equal(row['Cust. Code'],'MFCM0MF03');
  const unknown=structuredClone(manesar);for(const item of unknown.items)if(item.text==='MANESAR')item.text='OTHER_CITY';
  const empty=parsePage(unknown).rows[0];assert.equal(empty['Location(Plant)'],'');assert.equal(empty['Cust. Code'],'');
  assert.equal(plantForLocation('Gurgaon / Manesar'),null);
});
test('OCR comparisons derive mapped codes from item/location readings instead of comparing them against descriptions or bill-to codes',()=>{
  const row=parsePage(pages[0]).rows[0],same=text=>({windows:{text},tesseract:{text,confidence:95}});
  const fields=compareFields(row,{'Item Name':same('12221M72R00-300'),'Location(Plant)':same('GURGAON 122015'),'PART NAME':same('CRANKSHAFT'),'Cust. Code':same('M795')});
  for(const name of ['PART NAME','Location(Plant)','Cust. Code'])assert.equal(fields.find(r=>r.field===name).status,'MATCH');
  assert.equal(fields.find(r=>r.field==='PART NAME').comparison_source,'Item Name');
  const unmapped=compareFields({'PART NAME':''},{'Item Name':same('12221MZZZ99-300')});assert.equal(unmapped.find(r=>r.field==='PART NAME').status,'NO_MAPPING');
});
