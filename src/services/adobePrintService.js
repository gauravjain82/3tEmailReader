const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {promisify}=require('util');
const execute=promisify(require('child_process').execFile);
const script=path.resolve(__dirname,'../../scripts/adobe-print.ps1');
const powershellArgs=['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script];
function failureMessage(error) {
  const output=error.stdout?.trim().replace(/^\uFEFF/,'');
  if(output)try{return JSON.parse(output).error||output;}catch{return output;}
  return error.message;
}
function readJson(file) {try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}}
async function cleanupAdobe(jobPath) {
  if(fs.existsSync(jobPath+'.state.json'))return;
  await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'../../scripts/adobe-cleanup.ps1'),'-JobPath',jobPath],{windowsHide:true,timeout:10000,maxBuffer:32768});
}

async function checkAdobe({run=execute,env=process.env}={}) {
  const args=[...powershellArgs,'-Check'];
  if(env.ADOBE_READER)args.push('-AdobeExe',env.ADOBE_READER);
  try {
    const {stdout}=await run('powershell.exe',args,{windowsHide:true,timeout:20000,maxBuffer:65536});
    const report=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
    if(!report.ready||!report.executable||!report.printer)throw Error(report.error||'Incomplete Adobe readiness response');
    return report;
  }catch(error){throw Error('Adobe readiness check failed: '+failureMessage(error));}
}

async function submitAdobe({pdfPath,sha256,page,sessionFile,dryRun=false},{run=execute,env=process.env,onProgress=message=>console.log('[Adobe]',message),cleanup}={}) {
  const {PDFDocument,PDFName}=require('pdf-lib');
  const bytes=fs.readFileSync(pdfPath);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==sha256)throw Object.assign(Error('Original changed before Adobe printing'),{beforeSubmission:true});
  const pdf=await PDFDocument.load(bytes);
  // Reader's range field can use logical page labels. Avoid confusing those
  // labels with the physical page selected by our original-recipient parser.
  if(pdf.catalog.has(PDFName.of('PageLabels')))throw Object.assign(Error('This PDF uses custom page labels; Adobe automation requires manual page selection'),{beforeSubmission:true});
  if(!Number.isSafeInteger(page)||page<1||page>pdf.getPageCount())throw Object.assign(Error('Invalid Adobe print page'),{beforeSubmission:true});
  const jobPath=pdfPath+'.adobe-'+crypto.randomUUID()+'.json';
  // A session is shared across the whole batch, including per-invoice folders.
  const sessionPath=sessionFile||path.join(path.dirname(pdfPath),'adobe-session-'+crypto.randomUUID()+'.json');
  fs.writeFileSync(jobPath,JSON.stringify({pdfPath:path.resolve(pdfPath),sha256,page,sessionFile:sessionPath}));
  const args=[...powershellArgs,'-JobPath',jobPath];
  if(env.ADOBE_READER)args.push('-AdobeExe',env.ADOBE_READER);
  if(dryRun)args.push('-DryRun');
  const controller=new AbortController();
  let lastStage='',lastChange=Date.now();
  const timer=setInterval(()=>{
    const progress=readJson(jobPath+'.progress.json');
    if(progress?.stage&&progress.stage!==lastStage){lastStage=progress.stage;lastChange=Date.now();onProgress(lastStage);}
    if(Date.now()-lastChange>45000)controller.abort();
  },500);
  timer.unref();
  try {
    const {stdout}=await run('powershell.exe',args,{windowsHide:true,timeout:150000,maxBuffer:131072,signal:controller.signal});
    const report=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
    if(report.error||report.readerValidated!==true||report.page!==page||report.copies!==1||!report.printer||
       (dryRun?report.prepared!==true||report.submitted!==false:report.submitted!==true))throw Error(report.error||'Incomplete Adobe print response');
    fs.writeFileSync(jobPath+'.result.json',JSON.stringify(report,null,2));
    return report;
  }catch(error){
    const beforeSubmission=!fs.existsSync(jobPath+'.state.json');
    let worker;
    try{worker=JSON.parse(error.stdout?.trim().replace(/^\uFEFF/,''));}catch{}
    const progress=readJson(jobPath+'.progress.json');
    const stage=worker?.stage||lastStage||progress?.stage||'Starting the Adobe worker';
    const detail=error.name==='AbortError'?'Reader automation did not respond for 45 seconds':failureMessage(error);
    const resultPath=jobPath+'.result.json';
    const failure=Error(`Stopped at "${stage}": ${detail}. Details: ${resultPath}`);
    failure.beforeSubmission=beforeSubmission;
    failure.stage=stage;
    failure.resultPath=resultPath;
    const close=cleanup||(run===execute?cleanupAdobe:null);
    let cleanupError;
    if(beforeSubmission&&close)try{await close(jobPath);}catch(error){cleanupError=error.message;}
    fs.writeFileSync(resultPath,JSON.stringify({status:beforeSubmission?'FAILED':'UNCERTAIN',stage,error:detail,beforeSubmission,diagnosticPath:worker?.diagnosticPath||null,cleanupError:cleanupError||null},null,2));
    onProgress(`Stopped at ${stage}. Details: ${resultPath}`);
    throw failure;
  }finally{clearInterval(timer);}
}
module.exports={checkAdobe,submitAdobe};
