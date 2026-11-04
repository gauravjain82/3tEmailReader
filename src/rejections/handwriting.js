const fs=require('fs');
const path=require('path');
const {runHandwritingTest}=require('../../scripts/test-handwriting');
const {parseAcknowledgement}=require('./parser');
const root=path.resolve(__dirname,'../..');
function localHandwritingReady(){
  return fs.existsSync(path.join(root,'.handwriting-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'))&&fs.existsSync(path.join(root,'rejections','models','trocr-base-handwritten','source.json'));
}
async function readLocalHandwriting(file,output){
  return runHandwritingTest(['--input',file],{lock:false,setExitCode:false,outputRoot:path.join(output,'handwriting')});
}
function applyHandwriting(parsed,run,comparisons=[]){
  const results=(run?.results||[]).filter(r=>r.page===parsed.page&&r.invoice===parsed.invoiceNumber);
  parsed.localHandwriting={output:run?.output,results,pageErrors:(run?.pageErrors||[]).filter(e=>e.page===parsed.page)};
  let filled=0;
  for(const row of parsed.rows){
    for(const field of ['Ack. No','Ack Date']){
      const candidates=results.filter(r=>r.field===field&&r.status==='CONSISTENT_CANDIDATE');
      const unique=[...new Set(candidates.map(c=>c.candidate))];
      if(unique.length!==1)continue;
      const value=unique[0];
      if(field==='Ack. No'&&!/^\d{10}$/.test(value))continue;
      if(field==='Ack Date'){
        if(parseAcknowledgement(value,row['Invoice Date']).date!==value)continue;
        const iso=s=>s.split('.').reverse().join('-');
        if(iso(value)<iso(row['Invoice Date']))continue;
      }
      let comparisonConflict=false;
      for(const comparison of comparisons.filter(c=>c.field===field)){
        comparison.local_handwriting_value=value;comparison.local_handwriting_status='CONSISTENT_CANDIDATE';
        if(comparison.status==='MATCH'&&comparison.windows_value!==value){
          comparison.status='LOCAL_MODEL_CONFLICT';comparison.reason='Windows/Tesseract agreement differs from the local handwriting model.';comparisonConflict=true;
        }
      }
      if(comparisonConflict){parsed.issues.push(`Local handwriting model conflicts with existing OCR agreement on ${field}; no value was automatically substituted.`);continue;}
      if(row[field]&&row[field]!==value){parsed.issues.push(`Local handwriting model conflicts with the existing ${field}; neither value was silently substituted.`);continue;}
      if(!row[field]){row[field]=value;filled++;}
    }
  }
  if(filled){
    parsed.notes.push(`${filled} handwritten field value(s) populated from local TrOCR; two image variants agreed after whitespace/date-separator normalization. No digit substitutions or Excel values used.`);
    parsed.issues.push('Local handwriting values are model candidates, not independent verification; review any OCR disagreement.');
  }
  if(parsed.rows.every(r=>r['Ack. No']&&r['Ack Date']))parsed.issues=parsed.issues.filter(i=>!/Handwritten acknowledgement could not|Ack\. No missing|Ack Date missing/.test(i));
  return filled;
}
module.exports={localHandwritingReady,readLocalHandwriting,applyHandwriting};
