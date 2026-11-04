const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const {COLUMNS,parsePage}=require('../src/rejections/parser');
const {compareFields,applyComparison,extractField}=require('../src/rejections/ocr');
const {runBatch}=require('../scripts/parse-rejections');
const pages=require('./fixtures/rejections/mf02-pages.json');
const read=(a,b,confidence=95)=>({windows:{text:a},tesseract:{text:b,confidence}});
test('two-engine comparison normalizes formatting while preserving digit and description discrepancies',()=>{
  const row={'Invoice Date':'03.11.2026','Basic value':'1234.50','Qty':'5','PART NAME':'F01906FG0000','Ack. No':''};
  const results=compareFields(row,{'Invoice Date':read('03-Nov 2026','03.11.2026'),'Basic value':read('1,234.50','1234.50'),'Qty':read('5','5.00'),'Item Name':read('12221M72R00-300','12221M81R10-300'),'Ack. No':read('7400001363','7700001363')});
  const status=field=>results.find(r=>r.field===field).status;
  for(const field of ['Invoice Date','Basic value','Qty'])assert.equal(status(field),'MATCH');
  for(const field of ['PART NAME','Ack. No'])assert.equal(status(field),'DISAGREEMENT');
  assert.equal(extractField('Basic value','8633 85'),'8633.85');
  assert.equal(extractField('Invoice Date','DATE 103 Nov 2026','03.11.2026'),'');
  assert.equal(extractField('Qty','| 5.00'),'5');
});
test('agreement does not mask low confidence, missing readings, engine errors or PDF conflicts',()=>{
  const results=compareFields({'Qty':'5'},{'Qty':read('6','6'),'Item Name':read('12221M72R00-300','12221M72R00-300',45),'Location(Plant)':{windows:{error:'Not installed'},tesseract:{text:'GURGAON 122015',confidence:95}}});
  const status=field=>results.find(r=>r.field===field).status;
  assert.equal(status('Qty'),'PDF_TEXT_CONFLICT');assert.equal(status('Item Name'),'LOW_CONFIDENCE');
  assert.equal(status('PART NAME'),'LOW_CONFIDENCE');assert.equal(status('Cust. Code'),'ENGINE_ERROR');assert.equal(status('Ack. No'),'UNREADABLE');
});
test('acknowledgements need both fields to match and printed discrepancies keep their original candidate',()=>{
  const parsed=parsePage(pages[0]);
  const readings={'Ack. No':read('7700001361','7700001361'),'Ack Date':read('03-11-26','03-11-26'),'Qty':read('5','6')};
  const comparisons=compareFields(parsed.rows[0],readings).map(c=>({...c,line:1}));
  applyComparison(parsed,comparisons);assert.equal(parsed.rows[0]['Ack. No'],'7700001361');assert.equal(parsed.rows[0]['Ack Date'],'03.11.2026');
  assert.equal(parsed.rows[0].Qty,'5');assert.ok(parsed.issues.some(i=>i.includes('OCR field comparison')));
  const missing=parsePage(pages[0]);applyComparison(missing,compareFields(missing.rows[0],{'Ack. No':read('7700001361','7700001361')}).map(c=>({...c,line:1})));
  assert.equal(missing.rows[0]['Ack. No'],'');
});
test('batch writes per-field comparison and discrepancy reports, without treating unresolved candidates as verified',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rejection-dual-ocr-'));
  t.after(()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('rejection-dual-ocr-'));fs.rmSync(dir,{recursive:true,force:true});});
  const file=path.join(dir,'sample.pdf');fs.writeFileSync(file,'test placeholder');const output=path.join(dir,'output');
  const summary=await runBatch({input:file,output,read:async()=>[pages[0]],compare:async(_file,parsed)=>{
    const readings=Object.fromEntries(COLUMNS.map(c=>[c,read(parsed.rows[0][c],c==='Qty'?'6':parsed.rows[0][c])]));
    const result=compareFields(parsed.rows[0],readings).map(c=>({...c,line:1}));applyComparison(parsed,result);return result;
  }});
  assert.equal(summary.comparedFields,14);assert.equal(summary.discrepancies,3);assert.equal(summary.review,1);
  assert.match(fs.readFileSync(path.join(output,'discrepancy-report.csv'),'utf8'),/DISAGREEMENT/);
  assert.match(fs.readFileSync(path.join(output,'ocr-comparison.csv'),'utf8'),/MATCH/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output,'details.json'),'utf8'))[0].rows[0].Qty,'5');
});
