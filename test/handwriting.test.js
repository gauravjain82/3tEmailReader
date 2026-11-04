const {test}=require('node:test');
const assert=require('node:assert/strict');
const {lineRegions,assess}=require('../scripts/test-handwriting');
const {applyHandwriting}=require('../src/rejections/handwriting');
const {parsePage}=require('../src/rejections/parser');
const pages=require('./fixtures/rejections/mf02-pages.json');
test('handwriting test crops two separate top lines and excludes invoice tables and lower-page signatures',()=>{
  for(const page of pages){
    const boxes=lineRegions(page);assert.deepEqual(Object.keys(boxes),['number','date']);
    assert.ok(boxes.number.top>=.035);assert.ok(boxes.number.bottom<boxes.date.top);
    assert.ok(boxes.date.bottom<=.21);assert.ok(boxes.number.right<=.42);
    for(const box of Object.values(boxes)){assert.ok(box.right>box.left);assert.ok(box.bottom>box.top);}
  }
  assert.throws(()=>lineRegions({page:1,items:[]}),/location could not be established/);
});
test('same-model consistency remains a review candidate, never an automatic verification',()=>{
  const r=assess({field:'Ack. No',readings:[{text:'7700001361'},{text:'7700001361'}]},'03.11.2026');
  assert.equal(r.status,'CONSISTENT_CANDIDATE');assert.equal(r.candidate,'7700001361');assert.equal(r.requiresReview,true);
  assert.equal(assess({field:'Ack. No',readings:[{text:'7700001361'},{text:'7400001361'}]},'03.11.2026').status,'DISAGREEMENT');
  assert.equal(assess({field:'Ack. No',readings:[{text:'7700001361'},{text:'77O0001361'}]},'03.11.2026').status,'INCOMPLETE');
  assert.equal(assess({field:'Ack. No',readings:[{text:'N/A'},{text:'no reading'}]},'03.11.2026').status,'UNREADABLE');
});
test('handwriting dates require valid calendar values and agreeing variants',()=>{
  const r=assess({field:'Ack Date',readings:[{text:'03-11-26'},{text:'03.11.2026'}]},'03.11.2026');
  assert.equal(r.candidate,'03.11.2026');
  assert.equal(assess({field:'Ack Date',readings:[{text:'03 -11 -2 6'},{text:'03-11-26'}]},'03.11.2026').candidate,'03.11.2026');
  assert.equal(assess({field:'Ack Date',readings:[{text:'03-11-2.6.'},{text:'03-11-26'}]},'03.11.2026').candidate,'03.11.2026');
  const invalid=assess({field:'Ack Date',readings:[{text:'31-11-26'},{text:'31-11-26'}]},'03.11.2026');
  assert.equal(invalid.status,'UNREADABLE');assert.equal(invalid.candidate,'');
  const old=assess({field:'Ack Date',readings:[{text:'03-11-20'},{text:'03-11-20'}]},'03.11.2026');
  assert.equal(old.status,'DATE_BEFORE_INVOICE');assert.equal(old.candidate,'');
});

test('local handwriting candidates fill only the two handwriting fields and never replace conflicting accepted data',()=>{
  const parsed=parsePage(pages[0]),before=structuredClone(parsed.rows[0]);
  const result=field=>({page:1,invoice:parsed.invoiceNumber,field,status:'CONSISTENT_CANDIDATE',candidate:field==='Ack. No'?'7700001361':'03.11.2026'});
  const run={output:'local-test',results:[result('Ack. No'),result('Ack Date')]};
  assert.equal(applyHandwriting(parsed,run),2);assert.equal(parsed.rows[0]['Ack. No'],'7700001361');assert.equal(parsed.rows[0]['Ack Date'],'03.11.2026');
  for(const key of Object.keys(before).filter(k=>!['Ack. No','Ack Date'].includes(k)))assert.equal(parsed.rows[0][key],before[key]);
  assert.ok(parsed.issues.some(i=>i.includes('model candidates')));
  const conflicting=parsePage(pages[0]);conflicting.rows[0]['Ack. No']='7700001369';
  const comparison=[{field:'Ack. No',status:'MATCH',windows_value:'7700001369'}];
  applyHandwriting(conflicting,run,comparison);
  assert.equal(conflicting.rows[0]['Ack. No'],'7700001369');assert.equal(comparison[0].status,'LOCAL_MODEL_CONFLICT');assert.equal(comparison[0].local_handwriting_value,'7700001361');
  const invalid=parsePage(pages[0]);const bad={results:[{...result('Ack. No'),candidate:'123'},{...result('Ack Date'),candidate:'03.11.2020'}]};
  assert.equal(applyHandwriting(invalid,bad),0);assert.equal(invalid.rows[0]['Ack. No'],'');assert.equal(invalid.rows[0]['Ack Date'],'');
});
