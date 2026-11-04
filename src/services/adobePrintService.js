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

async function submitAdobe({pdfPath,sha256,page,sessionFile,dryRun=false},{run=execute,env=process.env}={}) {
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
  try {
    const {stdout}=await run('powershell.exe',args,{windowsHide:true,timeout:185000,maxBuffer:131072});
    const report=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
    if(report.error||report.readerValidated!==true||report.page!==page||report.copies!==1||!report.printer||
       (dryRun?report.prepared!==true||report.submitted!==false:report.submitted!==true))throw Error(report.error||'Incomplete Adobe print response');
    return report;
  }catch(error){
    const beforeSubmission=!fs.existsSync(jobPath+'.state.json');
    const failure=Error(failureMessage(error));
    failure.beforeSubmission=beforeSubmission;
    throw failure;
  }
}
module.exports={checkAdobe,submitAdobe};
