// Standalone local-PDF workflow. No Gmail, main invoice database or printer imports.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {COLUMNS,parsePage,readPages}=require('../src/rejections/parser');
const {createDualOcr}=require('../src/rejections/ocr');
const {localHandwritingReady,readLocalHandwriting,applyHandwriting}=require('../src/rejections/handwriting');
const {acquireRunLock}=require('../src/services/runLock');
const root=path.resolve(__dirname,'..');
function csvCell(value){
  let text=String(value??'');if(/^[=+@-]/.test(text))text="'"+text;
  return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
}
function writeCsv(file,columns,rows){
  fs.writeFileSync(file,'\uFEFF'+[columns.join(','),...rows.map(row=>columns.map(c=>csvCell(row[c])).join(','))].join('\r\n')+'\r\n');
}
function options(args){
  const result={};
  for(let n=0;n<args.length;n++){
    if(args[n]==='--no-handwriting'){result.handwriting=false;continue;}
    if(args[n]==='--check-gemini'){result.checkGemini=true;continue;}
    if(args[n]==='--engine'){
      const engine=args[++n];if(!['local','gemini'].includes(engine))throw Error('Usage: --engine local|gemini');result.engine=engine;continue;
    }
    if(args[n]==='--pages'){
      const value=args[++n];if(!/^\d+(?:,\d+)*$/.test(value||''))throw Error('Usage: --pages 1,3,5 (Gemini only)');
      result.pages=[...new Set(value.split(',').map(Number))];if(result.pages.some(n=>!Number.isSafeInteger(n)||n<1||n>10000))throw Error('Invalid page selection.');continue;
    }
    if(!['--input','--output'].includes(args[n])||!args[n+1]||args[n+1].startsWith('--'))throw Error('Usage: npm run rejections -- [--input PDF_OR_FOLDER] [--output FOLDER]');
    result[args[n].slice(2)]=path.resolve(args[++n]);
  }return result;
}
async function runBatch({input,output,read=readPages,extract=parsePage,compare,useHandwriting=true,handwriting=read===readPages&&useHandwriting&&localHandwritingReady()?readLocalHandwriting:null}){
  const stat=fs.statSync(input);
  const files=stat.isDirectory()?fs.readdirSync(input,{withFileTypes:true}).filter(e=>e.isFile()&&/\.pdf$/i.test(e.name)).map(e=>path.join(input,e.name)).sort():/\.pdf$/i.test(input)?[input]:[];
  if(!files.length)throw Error('No PDFs found. Add rejection PDFs to '+input+' and run again.');
  fs.mkdirSync(output,{recursive:true});
  const rows=[],report=[],details=[],comparisons=[],seen=new Map(),fileResults=[];
  let handwritingFieldsFilled=0;
  const ocr=read===readPages&&!compare?createDualOcr(output):null;
  const comparePage=compare||ocr?.compare;
  try{
  for(const file of files){
    const rowStart=rows.length,reportStart=report.length,invoiceStart=seen.size;
    let pages;
    console.log('Reading rejection PDF:',path.basename(file));
    try{pages=await read(file,{ocrOutput:path.join(output,'page-ocr')});}catch(error){report.push({filename:path.basename(file),page:'',status:'FAILED',reason:error.message});fileResults.push({filename:path.basename(file),pages:0,invoices:0,rows:0,failed:1,review:0,duplicates:0});continue;}
    let handwritingRun,handwritingError;
    if(handwriting)try{console.log('Reading two handwritten fields locally:',path.basename(file));handwritingRun=await handwriting(file,output,pages);}catch(error){handwritingError=error.message;}
    for(const page of pages){
      try{
        const parsed=await extract(page,file),identity=parsed.invoiceNumber.toUpperCase(),previous=seen.get(identity);
        const entry={filename:path.basename(file),page:page.page,invoice_number:identity};
        let fieldComparisons=[];
        if(comparePage){
          console.log('Comparing OCR readings:',path.basename(file),'page',page.page);
          const result=await comparePage(file,parsed);
          fieldComparisons=result;
          comparisons.push(...result.map(c=>({...entry,...c})));
        }
        if(handwritingRun){
          handwritingFieldsFilled+=applyHandwriting(parsed,handwritingRun,fieldComparisons);
          // Keep the CSV comparison copies in sync with the model's candidate readings.
          for(const comparison of comparisons.filter(c=>c.filename===entry.filename&&c.page===entry.page)){
            const source=fieldComparisons.find(c=>c.line===comparison.line&&c.field===comparison.field);
            if(source)Object.assign(comparison,{local_handwriting_value:source.local_handwriting_value,local_handwriting_status:source.local_handwriting_status,status:source.status,reason:source.reason});
          }
        }
        if(handwritingError)parsed.issues.push('Local handwriting model failed: '+handwritingError);
        details.push({...entry,...parsed});
        if(previous){
          const same=JSON.stringify(previous.rows)===JSON.stringify(parsed.rows);
          report.push({...entry,status:same?'DUPLICATE':'DUPLICATE_CONFLICT',reason:same?'Same invoice already included in this batch.':'Same invoice number has different data. First version retained; review both PDFs.'});
          continue;
        }
        seen.set(identity,parsed);rows.push(...parsed.rows);
        report.push({...entry,status:parsed.issues.length?'NEEDS_REVIEW':'PARSED',reason:[...parsed.issues,...parsed.notes].join(' ')});
      }catch(error){console.error('Page failed:',path.basename(file),'page',page.page,error.message);report.push({filename:path.basename(file),page:page.page,status:'FAILED',reason:error.message});}
    }
    const results=report.slice(reportStart);
    const fileSummary={filename:path.basename(file),pages:pages.length,invoices:seen.size-invoiceStart,rows:rows.length-rowStart,failed:results.filter(r=>r.status==='FAILED').length,review:results.filter(r=>['NEEDS_REVIEW','DUPLICATE_CONFLICT'].includes(r.status)).length,duplicates:results.filter(r=>r.status==='DUPLICATE').length};
    fileResults.push(fileSummary);
    console.log('PDF result:',fileSummary.filename,'pages:',fileSummary.pages,'invoice rows:',fileSummary.rows,'failed pages:',fileSummary.failed);
  }
  }finally{await ocr?.close();}
  fs.mkdirSync(output,{recursive:true});
  writeCsv(path.join(output,'rejections.csv'),COLUMNS,rows);
  writeCsv(path.join(output,'review-report.csv'),['filename','page','invoice_number','status','reason'],report);
  writeCsv(path.join(output,'file-summary.csv'),['filename','pages','invoices','rows','failed','review','duplicates'],fileResults);
  const comparisonColumns=['filename','page','invoice_number','line','field','comparison_source','pdf_value','windows_value','tesseract_value','tesseract_confidence','local_handwriting_value','local_handwriting_status','status','reason','windows_raw','tesseract_raw','crop'];
  writeCsv(path.join(output,'ocr-comparison.csv'),comparisonColumns,comparisons);
  writeCsv(path.join(output,'discrepancy-report.csv'),comparisonColumns,comparisons.filter(c=>c.status!=='MATCH'));
  fs.writeFileSync(path.join(output,'details.json'),JSON.stringify(details,null,2));
  const summary={files:files.length,invoices:seen.size,rows:rows.length,review:report.filter(r=>['NEEDS_REVIEW','DUPLICATE_CONFLICT'].includes(r.status)).length,failed:report.filter(r=>r.status==='FAILED').length,duplicates:report.filter(r=>r.status==='DUPLICATE').length,comparedFields:comparisons.length,matchingFields:comparisons.filter(c=>c.status==='MATCH').length,discrepancies:comparisons.filter(c=>c.status!=='MATCH').length,handwritingFieldsFilled,fileResults,output};
  fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(summary,null,2));
  return summary;
}
async function main(args=process.argv.slice(2)){
  require('dotenv').config({path:path.join(root,'.env')});
  const flags=options(args),base=path.join(root,'rejections');
  if(flags.pages&&flags.engine!=='gemini')throw Error('--pages requires --engine gemini.');
  let cloudConfig,cloudClient;
  if(flags.checkGemini||flags.engine==='gemini'){
    const {settings,createVertexClient}=require('../src/rejections/gemini');
    cloudConfig=settings();cloudClient=createVertexClient(cloudConfig);
    const checked=await cloudClient.check();console.log('Vertex configuration:',JSON.stringify(checked));
    if(flags.checkGemini)return;
  }
  const input=flags.input||path.join(base,'input');
  fs.mkdirSync(base,{recursive:true});if(!flags.input)fs.mkdirSync(input,{recursive:true});
  const unlock=acquireRunLock(base);
  try{
    const output=flags.output||path.join(base,'output',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8));
    if(fs.existsSync(output)&&fs.readdirSync(output).length)throw Error('Output folder must be empty; previous results were retained.');
    let engineOptions={};
    if(flags.engine==='gemini'){
      const {createGeminiExtractor}=require('../src/rejections/gemini');
      const cloud=createGeminiExtractor(cloudConfig,output,{client:cloudClient});
      console.log('Gemini mode: selected invoice pages will be sent to Google Cloud. API usage is billable.');
      engineOptions={read:async file=>{
        const pages=await cloud.read(file);
        if(flags.pages?.some(n=>n>pages.length))throw Error('Requested page is outside this PDF.');
        return flags.pages?pages.filter(p=>flags.pages.includes(p.page)):pages;
      },extract:async(page,file)=>{console.log('Gemini extraction:',path.basename(file),'page',page.page);return cloud.extract(page,file);},handwriting:null};
    }
    const summary=await runBatch({input,output,useHandwriting:flags.handwriting!==false,...engineOptions});
    console.log(JSON.stringify(summary,null,2));
    console.log('Open:',path.join(output,'rejections.csv'));
    console.log('Review:',path.join(output,'review-report.csv'));
    if(summary.failed||summary.review)process.exitCode=1;
  }finally{unlock();}
}
if(require.main===module)main().catch(error=>{console.error('Rejection parser:',error.message);process.exitCode=1;});
module.exports={runBatch,options};
