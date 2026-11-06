// Bootstrap printed text for scanned pages before the positional parser runs.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const execute=require('util').promisify(require('child_process').execFile);
const cache=new Map();
function tsvItems(tsv,width,height){
  return String(tsv||'').split(/\r?\n/).slice(1).flatMap(line=>{
    const c=line.split('\t');
    if(c[0]!=='5'||!c[11]?.trim())return [];
    return [{text:c.slice(11).join('\t'),x:Number(c[6])/width,y:(Number(c[7])+Number(c[9]))/height,w:Number(c[8])/width,confidence:Number(c[10])}];
  });
}
function createPageOcr(data,{output=path.resolve(__dirname,'../../rejections/ocr-cache')}={}){
  let parser,worker,workerError;
  const hash=crypto.createHash('sha256').update(data).digest('hex');
  async function recognize(image){
    let timer;
    try{return await Promise.race([worker.recognize(image,{},{tsv:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Full-page OCR timed out.')),60000);})]);}
    catch(error){workerError=error.message;await worker?.terminate();worker=null;throw error;}
    finally{clearTimeout(timer);}
  }
  async function read(page){
    const key=hash+':'+page;
    if(cache.has(key))return structuredClone(await cache.get(key));
    const pending=(async()=>{
      fs.mkdirSync(output,{recursive:true});
      const {PDFParse}=require('pdf-parse');
      parser ||= new PDFParse({data:new Uint8Array(data)});
      if(workerError)throw Error(workerError);
      if(!worker){
        const {createWorker}=require('tesseract.js'),model=require('@tesseract.js-data/eng');
        worker=await createWorker('eng',1,{langPath:model.langPath,gzip:true,cacheMethod:'none',cachePath:output,errorHandler:()=>{}});
      }
      console.log('Full-page OCR for scanned PDF:',hash.slice(0,8),'page',page);
      const image=(await parser.getScreenshot({partial:[page],scale:4,imageBuffer:true,imageDataUrl:false})).pages[0];
      await worker.setParameters({tessedit_pageseg_mode:'3'});
      const {data:reading}=await recognize(image.data);
      fs.writeFileSync(path.join(output,`${hash.slice(0,12)}-page-${page}.tsv`),reading.tsv);
      const result={page,items:tsvItems(reading.tsv,image.width,image.height),textSource:'scanned-page-ocr',ocrEngine:'Tesseract',ocrConfidence:reading.confidence};
      if(process.platform==='win32')try{
        const windowsImage=(await parser.getScreenshot({partial:[page],scale:2.5,imageBuffer:true,imageDataUrl:false})).pages[0];
        const imagePath=path.resolve(output,`${hash.slice(0,12)}-page-${page}.png`);fs.writeFileSync(imagePath,windowsImage.data);
        const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'../../scripts/rejection-ocr.ps1'),'-ImagePath',imagePath,'-IncludeWords'],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
        result.alternativeItems=JSON.parse(stdout.replace(/^\uFEFF/,'').trim()).words;
      }catch(error){result.windowsOcrError=error.message;}
      // Table-only OCR avoids the QR code and handwriting confusing page layout.
      // Keep the full-page/Windows words as independent header-anchor candidates.
      const anchors=[...result.items,...(result.alternativeItems||[])];
      const packing=anchors.filter(i=>/^Packing$/i.test(i.text)&&i.y>.3&&i.y<.7).sort((a,b)=>a.y-b.y)[0];
      const grand=anchors.filter(i=>/^Grand$/i.test(i.text)&&i.y>(packing?.y||.4)+.04&&i.y<.8).sort((a,b)=>a.y-b.y)[0];
      const box={x:.05,y:Math.max(.3,(packing?.y||.425)-.035),width:.92};
      box.height=Math.min(.8,(grand?.y||.55)+.025)-box.y;
      const {createCanvas,loadImage}=require('@napi-rs/canvas');
      const original=await loadImage(image.data),canvas=createCanvas(Math.round(image.width*box.width),Math.round(image.height*box.height));
      canvas.getContext('2d').drawImage(original,image.width*box.x,image.height*box.y,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
      await worker.setParameters({tessedit_pageseg_mode:'6'});
      const table=(await recognize(canvas.toBuffer('image/png'))).data;
      const tableItems=tsvItems(table.tsv,canvas.width,canvas.height).map(i=>({...i,x:box.x+i.x*box.width,y:box.y+i.y*box.height,w:i.w*box.width}));
      result.alternativeItems=anchors;
      result.items=[...result.items.filter(i=>i.y<box.y||i.y>box.y+box.height),...tableItems];
      fs.writeFileSync(path.join(output,`${hash.slice(0,12)}-page-${page}-table.tsv`),table.tsv);
      fs.writeFileSync(path.join(output,`${hash.slice(0,12)}-page-${page}.json`),JSON.stringify(result,null,2));
      return result;
    })();
    cache.set(key,pending);
    try{return structuredClone(await pending);}catch(error){cache.delete(key);throw error;}
  }
  async function close(){if(worker)await worker.terminate();if(parser)await parser.destroy();}
  return {read,close};
}
module.exports={createPageOcr,tsvItems};
