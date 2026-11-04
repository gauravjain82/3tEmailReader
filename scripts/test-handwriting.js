const fs=require('fs');
const path=require('path');
const {spawn}=require('child_process');
const {PDFParse}=require('pdf-parse');
const {readPages,parsePage,parseAcknowledgement}=require('../src/rejections/parser');
const {acquireRunLock}=require('../src/services/runLock');
const root=path.resolve(__dirname,'..');
function lineRegions(page){
  const anchor=page.items.filter(i=>i.x>.06&&i.x<.45&&i.y>.07&&i.y<.18&&i.w>.08&&(i.text.match(/[\dOoIl|]/g)||[]).length>=8).sort((a,b)=>b.w-a.w)[0];
  if(!anchor)throw Error(`Page ${page.page}: handwritten number location could not be established from this template.`);
  const left=Math.max(.04,anchor.x-.06),right=Math.min(.42,anchor.x+anchor.w+.04);
  return {number:{left,right,top:Math.max(.035,anchor.y-.055),bottom:anchor.y+.006},date:{left,right,top:anchor.y+.008,bottom:Math.min(.21,anchor.y+.06)}};
}
function assess(result,invoiceDate){
  const values=result.readings.map(r=>{
    const text=r.text.trim();
    if(result.field==='Ack. No'){
      const compact=text.replace(/\s/g,'').replace(/^[#.:]|[.,;:]$/g,'');
      return /^\d{10}$/.test(compact)?compact:'';
    }
    const compact=text.replace(/\s/g,'');
    const regular=parseAcknowledgement(compact,invoiceDate).date;
    if(regular)return regular;
    // Date separators can be misplaced by OCR. Preserve every digit and require
    // exactly DDMMYY/DDMMYYYY plus a valid calendar date; never fix a digit.
    if(!/^[\d./-]+$/.test(compact))return '';
    const digits=compact.replace(/[./-]/g,'');
    if(!/^\d{6}(?:\d{2})?$/.test(digits))return '';
    return parseAcknowledgement(`${digits.slice(0,2)}-${digits.slice(2,4)}-${digits.slice(4)}`,invoiceDate).date;
  });
  const unique=[...new Set(values.filter(Boolean))];
  let status=unique.length>1?'DISAGREEMENT':unique.length===0?'UNREADABLE':values.some(v=>!v)?'INCOMPLETE':'CONSISTENT_CANDIDATE';
  if(status==='CONSISTENT_CANDIDATE'&&result.field==='Ack Date'&&/^\d{2}\.\d{2}\.\d{4}$/.test(invoiceDate)){
    const iso=s=>s.split('.').reverse().join('-');
    if(iso(unique[0])<iso(invoiceDate))status='DATE_BEFORE_INVOICE';
  }
  return {...result,status,candidate:status==='CONSISTENT_CANDIDATE'?unique[0]:'',normalizedReadings:values,requiresReview:true};
}
function writeReview(output,raw,file,pageErrors=[]){
  const results=raw.results.map(r=>assess(r,r.invoiceDate));
  fs.writeFileSync(path.join(output,'review.json'),JSON.stringify({sourcePdf:file,...raw,results,pageErrors,note:'Same-model consistency is not independent verification; results are experimental candidates requiring review. Only whitespace and separators are normalized; digits are not corrected.'},null,2));
  const cell=value=>'"'+String(value??'').replace(/"/g,'""')+'"';
  const columns=['page','invoice','field','status','candidate','original','contrast'];
  fs.writeFileSync(path.join(output,'handwriting-test.csv'),'\uFEFF'+[columns.join(','),...results.map(r=>[r.page,r.invoice,r.field,r.status,r.candidate,r.readings[0].text,r.readings[1].text].map(cell).join(','))].join('\r\n')+'\r\n');
  return results;
}
async function main(args=process.argv.slice(2),{lock=true,outputRoot,setExitCode=true}={}){
  let input;
  if(args.length===1&&args[0]==='--choose'){
    const prompt=require('node:readline/promises').createInterface({input:process.stdin,output:process.stdout});
    try{input=(await prompt.question('Enter the full rejection PDF path: ')).trim().replace(/^"(.*)"$/,'$1');}finally{prompt.close();}
  }else if(args.length===2&&args[0]==='--input')input=args[1];
  else if(args.length===1&&!args[0].startsWith('--'))input=args[0];
  else throw Error('Usage: npm run handwriting:test -- --input "C:\\Invoices\\Rejection.pdf"');
  const file=path.resolve(input||'');
  if(!/\.pdf$/i.test(file)||!fs.statSync(file).isFile())throw Error('A PDF file is required.');
  const executable=path.join(root,'.handwriting-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!fs.existsSync(executable))throw Error('Run Setup Handwriting OCR.cmd first.');
  const release=lock?acquireRunLock(path.join(root,'rejections')):()=>{};
  try{
  const output=path.join(outputRoot||path.join(root,'rejections','handwriting-tests'),new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(output,{recursive:true});
  const {createCanvas,loadImage}=require('@napi-rs/canvas');
  const pages=await readPages(file),images=[],pageErrors=[];
  const parser=new PDFParse({data:new Uint8Array(fs.readFileSync(file))});
  try{
    for(const page of pages){
      try{
        const parsed=parsePage(page),regions=lineRegions(page);
        const screenshot=await parser.getScreenshot({partial:[page.page],scale:4,imageBuffer:true,imageDataUrl:false}),image=await loadImage(screenshot.pages[0].data);
        const combined={left:regions.number.left,right:regions.number.right,top:regions.number.top,bottom:regions.date.bottom};
        const headerCanvas=createCanvas(Math.ceil(image.width*(combined.right-combined.left)),Math.ceil(image.height*(combined.bottom-combined.top)));
        headerCanvas.getContext('2d').drawImage(image,image.width*combined.left,image.height*combined.top,headerCanvas.width,headerCanvas.height,0,0,headerCanvas.width,headerCanvas.height);
        const headerPath=path.join(output,`page-${page.page}-handwritten-header.png`);fs.writeFileSync(headerPath,headerCanvas.toBuffer('image/png'));
        for(const [key,box] of Object.entries(regions)){
          const width=Math.ceil(image.width*(box.right-box.left)),height=Math.ceil(image.height*(box.bottom-box.top)),padding=16;
          const canvas=createCanvas(width+padding*2,height+padding*2),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
          ctx.drawImage(image,image.width*box.left,image.height*box.top,width,height,padding,padding,width,height);
          const crop=path.join(output,`page-${page.page}-${key}.png`);fs.writeFileSync(crop,canvas.toBuffer('image/png'));
          images.push({page:page.page,invoice:parsed.invoiceNumber,invoiceDate:parsed.rows[0]['Invoice Date'],field:key==='number'?'Ack. No':'Ack Date',path:crop,headerPath,region:box});
        }
      }catch(error){pageErrors.push({page:page.page,error:error.message});}
    }
  }finally{await parser.destroy();}
  const manifest=path.join(output,'manifest.json'),reportFile=path.join(output,'model-readings.json');
  fs.writeFileSync(manifest,JSON.stringify({sourcePdf:file,images,pageErrors},null,2));
  if(!images.length)throw Error('No supported handwriting crops found. See '+manifest);
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,[path.join(root,'scripts','handwriting_worker.py'),'--manifest',manifest,'--output',reportFile],{cwd:root,stdio:'inherit',windowsHide:true,env:{...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}});
    const timeout=setTimeout(()=>{child.kill();reject(Error('Local handwriting test exceeded 10 minutes. Partial results are retained at '+output));},600000);
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('exit',code=>{clearTimeout(timeout);if(code===0)resolve();else reject(Error('Local handwriting worker failed. See the output above.'));});
  });
  const raw=JSON.parse(fs.readFileSync(reportFile,'utf8'));
  const results=writeReview(output,raw,file,pageErrors);
  console.log('Handwriting test output:',output);
  for(const r of results)console.log(r.invoice,r.field,r.status,r.candidate);
  if(setExitCode&&(results.some(r=>r.status!=='CONSISTENT_CANDIDATE')||pageErrors.length))process.exitCode=1;
  return {output,results,pageErrors};
  }finally{release();}
}
if(require.main===module)main().catch(error=>{console.error('Handwriting test:',error.message);process.exitCode=1;});
module.exports={lineRegions,assess,writeReview,runHandwritingTest:main};
