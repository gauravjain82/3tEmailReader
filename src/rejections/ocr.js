const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {promisify}=require('util');
const execute=promisify(require('child_process').execFile);
const {COLUMNS,date,parseAcknowledgement}=require('./parser');
const {decimal}=require('../pdf/decimal');
const {extractItemName,partNameForItem,plantForLocation}=require('./mappings');
const MONEY=new Set(['Basic value','Packing charges','CGST Amt.','SGST Amt.','Total Value']);
function extractField(field,text,invoiceDate){
  const raw=String(text||'').trim().replace(/^[|\[\]{}]+|[|\[\]{}]+$/g,'').trim(),compact=raw.replace(/\s/g,'').toUpperCase();
  if(!raw)return '';
  if(field==='Invoice Number')return compact.match(/\bHG\d{10}\b/)?.[0]||'';
  if(field==='Invoice Date')return date(raw)||parseAcknowledgement(raw,invoiceDate).date;
  if(field==='Ack. No'||field==='Ack Date')return parseAcknowledgement(raw,invoiceDate)[field==='Ack. No'?'number':'date'];
  if(field==='Item Name')return extractItemName(raw);
  if(field==='PART NAME')return partNameForItem(extractItemName(raw));
  if(field==='Location(Plant)')return plantForLocation(raw)?.location||'';
  if(field==='Cust. Code')return plantForLocation(raw)?.customerCode||'';
  if(field==='Qty'){
    const m=raw.match(/^\s*(\d+(?:\.\d+)?)\s*$/);return m?m[1].replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1'):'';
  }
  if(MONEY.has(field)){
    const spaced=raw.match(/^\s*(\d[\d,]*)\s+(\d{2})\s*$/);
    if(spaced)return decimal(spaced[1].replace(/,/g,'')+'.'+spaced[2]);
    const candidates=[...new Set([...raw.replace(/,/g,'').matchAll(/(?<![\d.])\d+\.\s*\d{2}(?!\d)/g)].map(m=>decimal(m[0].replace(/\s/g,''))))].filter(Boolean);
    return candidates.length===1?candidates[0]:'';
  }
  return raw.toUpperCase().replace(/\s+/g,' ').trim();
}
function normalized(field,value,invoiceDate){
  if(!value)return '';
  if(field==='Invoice Date'||field==='Ack Date')return /^\d{2}\.\d{2}\.\d{4}$/.test(value)?value:'';
  return extractField(field,value,invoiceDate);
}
function compareFields(row,readings){
  return COLUMNS.map(field=>{
    const mapped=['PART NAME','Location(Plant)','Cust. Code'].includes(field);
    const sourceField=field==='PART NAME'?'Item Name':field==='Cust. Code'?'Location(Plant)':field;
    const r=readings[sourceField]||{},windows=r.windows||{},tesseract=r.tesseract||{};
    const a=extractField(field,windows.text,row['Invoice Date']),b=extractField(field,tesseract.text,row['Invoice Date']);
    const source=mapped?row[field]||'':normalized(field,row[field],row['Invoice Date']);
    let status;
    if(windows.error||tesseract.error)status='ENGINE_ERROR';
    else if(field==='PART NAME'&&!a&&!b&&extractItemName(windows.text)&&extractItemName(windows.text)===extractItemName(tesseract.text))status='NO_MAPPING';
    else if(mapped&&!a&&!b&&String(windows.text||'').trim()&&String(windows.text).toUpperCase().replace(/\s/g,'')===String(tesseract.text||'').toUpperCase().replace(/\s/g,''))status='NO_MAPPING';
    else if(!a&&!b)status='UNREADABLE';
    else if(!a||!b)status='MISSING_READING';
    else if(a!==b)status='DISAGREEMENT';
    else if(!Number.isFinite(tesseract.confidence)||tesseract.confidence<(field==='Ack. No'||field==='Ack Date'?80:70))status='LOW_CONFIDENCE';
    else if(source&&source!==a)status='PDF_TEXT_CONFLICT';
    else status='MATCH';
    return {field,comparison_source:sourceField,pdf_value:row[field]||'',windows_value:a,tesseract_value:b,tesseract_confidence:tesseract.confidence??'',status,windows_raw:windows.text||'',tesseract_raw:tesseract.text||'',reason:status==='NO_MAPPING'?'No supplied mapping for the recognized source; output left blank.':[windows.error,tesseract.error].filter(Boolean).join('; '),crop:r.crop||''};
  });
}
function applyComparison(parsed,comparisons){
  for(let n=0;n<parsed.rows.length;n++){
    const fields=comparisons.filter(c=>c.line===n+1),row=parsed.rows[n];
    const ack=fields.find(c=>c.field==='Ack. No'),ackDate=fields.find(c=>c.field==='Ack Date');
    if(ack?.status==='MATCH'&&ackDate?.status==='MATCH'){
      row['Ack. No']=ack.windows_value;row['Ack Date']=ackDate.windows_value;
      parsed.notes.push('Acknowledgement confirmed by Windows OCR and Tesseract (Tesseract confidence >=80).');
    }
  }
  if(parsed.rows.every(r=>r['Ack. No']&&r['Ack Date']))parsed.issues=parsed.issues.filter(i=>!/Handwritten acknowledgement|Ack\. No missing|Ack Date missing/.test(i));
  const flagged=comparisons.filter(c=>c.status!=='MATCH');
  if(flagged.length)parsed.issues.push(`${flagged.length} OCR field comparison(s) require review; see discrepancy-report.csv. PDF-text candidate values are retained, not automatically resolved.`);
  parsed.ocrComparison=comparisons;
}
function createDualOcr(output){
  let workerPromise,worker,workerError;
  const pdfs=new Map();
  async function getWorker(){
    if(workerError)throw Error(workerError);
    if(!workerPromise)workerPromise=(async()=>{
      const {createWorker}=require('tesseract.js'),model=require('@tesseract.js-data/eng');
      const cache=path.join(output,'ocr-cache');fs.mkdirSync(cache,{recursive:true});
      worker=await createWorker('eng',1,{langPath:model.langPath,gzip:true,cachePath:cache,cacheMethod:'none',errorHandler:()=>{}});
      return worker;
    })().catch(e=>{workerError=e.message;throw e;});
    return workerPromise;
  }
  async function readTesseract(image,handwriting){
    try{
      const active=await getWorker();
      await active.setParameters({tessedit_pageseg_mode:handwriting?'6':'7'});
      let timer;
      try{
        const result=await Promise.race([active.recognize(image),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Tesseract OCR timed out.')),30000);})]);
        return {text:result.data.text,confidence:result.data.confidence};
      }catch(error){workerError=error.message;await worker?.terminate();worker=null;throw error;}
      finally{clearTimeout(timer);}
    }catch(error){return {error:error.message};}
  }
  async function readWindows(crop){
    if(process.platform!=='win32')return {error:'Windows OCR is unavailable on this operating system.'};
    try{
      const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve(__dirname,'../../scripts/rejection-ocr.ps1'),'-ImagePath',crop],{windowsHide:true,timeout:30000,maxBuffer:128*1024});
      const result=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
      return {text:(result.lines||[]).join('\n')||result.text||''};
    }catch(error){return {error:String(error.stderr||error.message).trim().slice(0,600)};}
  }
  async function compare(file,parsed){
    const comparisons=[];
    try{
      const {PDFParse}=require('pdf-parse'),{createCanvas,loadImage}=require('@napi-rs/canvas');
      if(!pdfs.has(file))pdfs.set(file,new PDFParse({data:new Uint8Array(fs.readFileSync(file))}));
      const rendered=await pdfs.get(file).getScreenshot({partial:[parsed.page],scale:4,imageBuffer:true,imageDataUrl:false});
      const image=await loadImage(rendered.pages[0].data),cache=new Map();
      const directory=path.join(output,'ocr-crops');fs.mkdirSync(directory,{recursive:true});
      const prefix=crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0,12);
      for(let n=0;n<parsed.rows.length;n++){
        const readings={};
        for(const field of COLUMNS){
          const box=parsed.fieldRegions[n][field];
          if(!box||box.width<=0||box.height<=0){readings[field]={windows:{error:'PDF field location unavailable.'},tesseract:{error:'PDF field location unavailable.'}};continue;}
          const key=JSON.stringify(box);if(cache.has(key)){readings[field]=cache.get(key);continue;}
          const w=Math.ceil(image.width*box.width),h=Math.ceil(image.height*box.height),padding=16;
          const canvas=createCanvas(w+padding*2,h+padding*2),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
          ctx.drawImage(image,image.width*box.x,image.height*box.y,w,h,padding,padding,w,h);
          const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
          // Remove long table rules without changing character shapes or digits.
          const columns=[],lines=[];
          const dark=(x,y)=>pixels.data[(y*canvas.width+x)*4]<185;
          for(let x=padding;x<padding+w;x++){let count=0;for(let y=padding;y<padding+h;y++)if(dark(x,y))count++;if(count/h>.8)columns.push(x);}
          for(let y=padding;y<padding+h;y++){let count=0;for(let x=padding;x<padding+w;x++)if(dark(x,y))count++;if(count/w>.8)lines.push(y);}
          for(const x of columns)for(let y=padding;y<padding+h;y++)for(let dx=-1;dx<=1;dx++){const j=(y*canvas.width+x+dx)*4;pixels.data[j]=pixels.data[j+1]=pixels.data[j+2]=255;}
          for(const y of lines)for(let x=padding;x<padding+w;x++)for(let dy=-1;dy<=1;dy++){const j=((y+dy)*canvas.width+x)*4;pixels.data[j]=pixels.data[j+1]=pixels.data[j+2]=255;}
          ctx.putImageData(pixels,0,0);
          const original=canvas.toBuffer('image/png');
          for(let j=0;j<pixels.data.length;j+=4){const v=Math.min(pixels.data[j],pixels.data[j+1])<220?0:255;pixels.data[j]=pixels.data[j+1]=pixels.data[j+2]=v;}
          ctx.putImageData(pixels,0,0);
          const crop=path.join(directory,`${prefix}-page-${parsed.page}-line-${n+1}-${field.replace(/[^a-z0-9]/gi,'_')}.png`);
          fs.writeFileSync(crop,original);
          const binaryCrop=crop.replace(/\.png$/,'.windows.png');fs.writeFileSync(binaryCrop,canvas.toBuffer('image/png'));
          const results=await Promise.allSettled([readWindows(binaryCrop),readTesseract(original,field==='Ack. No'||field==='Ack Date')]);
          const reading={crop,windows:results[0].status==='fulfilled'?results[0].value:{error:String(results[0].reason)},tesseract:results[1].status==='fulfilled'?results[1].value:{error:String(results[1].reason)}};
          readings[field]=reading;cache.set(key,reading);
        }
        comparisons.push(...compareFields(parsed.rows[n],readings).map(c=>({...c,line:n+1})));
      }
    }catch(error){
      for(let n=0;n<parsed.rows.length;n++)comparisons.push(...COLUMNS.map(field=>({field,line:n+1,pdf_value:parsed.rows[n][field],status:'ENGINE_ERROR',reason:error.message})));
    }
    applyComparison(parsed,comparisons);
    return comparisons;
  }
  async function close(){
    if(worker)await worker.terminate();
    for(const parser of pdfs.values())await parser.destroy();
  }
  return {compare,close};
}
module.exports={createDualOcr,compareFields,extractField,applyComparison};
