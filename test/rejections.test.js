const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const {parsePage,COLUMNS,parseAcknowledgement}=require('../src/rejections/parser');
const {runBatch,options}=require('../scripts/parse-rejections');
const pages=require('./fixtures/rejections/mf02-pages.json');
const {partNameForItem}=require('../src/rejections/mappings');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-rejections-'));
  t.after(()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-rejections-'));fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}
test('all four supplied rejection pages reproduce printed fields despite split/merged OCR and shifted columns',()=>{
  const expected=[['HG1001197517','12221M72R00-300','5','8633.85','172.68','792.59','10391.71'],['HG1001197515','12221M81R10-300','7','9427.60','188.55','865.45','11347.05'],['HG1001197521','12221M72R00-300','4','6907.08','138.14','634.07','8313.36'],['HG1001197523','12221M81R10-300','8','10774.40','215.49','989.09','12968.07']];
  for(let n=0;n<pages.length;n++){
    const parsed=parsePage(pages[n]),row=parsed.rows[0];assert.equal(parsed.rows.length,1);
    assert.deepEqual(['Invoice Number','Item Name','Qty','Basic value','Packing charges','CGST Amt.','Total Value'].map(c=>row[c]),expected[n]);
    assert.equal(row['Invoice Date'],'03.11.2026');assert.equal(row['SGST Amt.'],row['CGST Amt.']);
    assert.equal(row['PART NAME'],partNameForItem(row['Item Name']));
    assert.equal(row['Location(Plant)'],'Gurgaon(MF02)');assert.equal(row['Cust. Code'],'MFCM0MF02');
    assert.equal(row['Ack. No'],'');assert.equal(row['Ack Date'],'');
    assert.ok(parsed.issues.every(i=>/acknowledgement|Ack|description/i.test(i)),parsed.issues.join(';'));
  }
});
test('PDF-only parsing cannot inject Excel values or old configuration overrides',()=>{
  const poisoned={location:'EXCEL_PLANT',customerCode:'EXCEL_CODE',parts:{'12221M72R00-300':'EXCEL_PART'},acknowledgements:{HG1001197517:{number:'7700001361',date:'03.11.2026',source:'Excel'}}};
  const parsed=parsePage(pages[0],poisoned);
  assert.equal(parsed.rows[0]['Cust. Code'],'MFCM0MF02');assert.equal(parsed.rows[0]['PART NAME'],'F01906FG0000');
  assert.equal(parsed.rows[0]['Ack. No'],'');assert.equal(parsed.rows[0]['Ack Date'],'');
  assert.ok(!JSON.stringify(parsed.rows).includes('EXCEL'));
});
test('acknowledgements use exact PDF/OCR text and reject ambiguity or invalid dates',()=>{
  assert.deepEqual(parseAcknowledgement('7700001361\n03-11-26','03.11.2026'),{number:'7700001361',date:'03.11.2026'});
  assert.deepEqual(parseAcknowledgement('7+0000)36\n31-11-26','03.11.2026'),{number:'',date:''});
  assert.equal(parseAcknowledgement('7700001361\n7700001362').number,'');
  const page=structuredClone(pages[0]);page.ackOcr={lines:['7700001361','03-11-26'],engine:'test PDF crop OCR'};
  const unconfirmed=parsePage(page);assert.equal(unconfirmed.rows[0]['Ack. No'],'');
  page.items.push({text:'7700001361',x:.16,y:.10,w:.2},{text:'03-11-26',x:.17,y:.15,w:.15});
  const parsed=parsePage(page);assert.equal(parsed.rows[0]['Ack. No'],'7700001361');assert.equal(parsed.rows[0]['Ack Date'],'03.11.2026');
  assert.deepEqual(parsed.issues,[]);
  const wrong=structuredClone(pages[2]);wrong.ackOcr={lines:['7400001363'],engine:'test OCR with digit error'};
  const blocked=parsePage(wrong);assert.equal(blocked.rows[0]['Ack. No'],'');assert.equal(blocked.acknowledgementCandidates.imageOcr.number,'7400001363');
});
test('amounts that fail reconciliation are left blank for review and unrelated pages are rejected',()=>{
  const modified=structuredClone(pages[0]);
  for(const i of modified.items)if(i.text==='10391.71')i.text='10392.71';
  const parsed=parsePage(modified);assert.equal(parsed.rows[0]['Total Value'],'');
  assert.ok(parsed.issues.some(i=>i.includes('reconciled')));
  assert.throws(()=>parsePage({page:1,items:[{text:'Tax Invoice',x:.2,y:.1,w:.1}]}),/Unsupported/);
});
test('batch isolates failures, exports exact Excel columns, and suppresses repeated invoices',async t=>{
  const dir=fixture(t),input=path.join(dir,'input'),output=path.join(dir,'output');fs.mkdirSync(input);
  for(const file of ['a.pdf','b.PDF','broken.pdf'])fs.writeFileSync(path.join(input,file),'test placeholder');
  fs.writeFileSync(path.join(dir,'mail-checkpoint.txt'),'unchanged');
  const summary=await runBatch({input,output,read:async file=>{if(file.endsWith('broken.pdf'))throw Error('Unreadable PDF');return pages;}});
  assert.equal(summary.invoices,4);assert.equal(summary.rows,4);assert.equal(summary.duplicates,4);assert.equal(summary.failed,1);
  const csv=fs.readFileSync(path.join(output,'rejections.csv'),'utf8').replace(/^\uFEFF/,'');
  assert.equal(csv.split('\r\n')[0],COLUMNS.join(','));assert.equal(csv.trim().split('\r\n').length,5);
  assert.match(fs.readFileSync(path.join(output,'review-report.csv'),'utf8'),/FAILED,Unreadable PDF/);
  assert.equal(fs.readFileSync(path.join(dir,'mail-checkpoint.txt'),'utf8'),'unchanged');
  assert.equal(fs.existsSync(path.join(dir,'invoices.db')),false);
});
test('command line rejects unknown and missing arguments',()=>{
  assert.throws(()=>options(['--fresh']),/Usage/);assert.throws(()=>options(['--input']),/Usage/);
  assert.throws(()=>options(['--config','reference.json']),/Usage/);
  assert.equal(options(['--input','sample.pdf']).input,path.resolve('sample.pdf'));
});
