const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {spawnSync}=require('child_process');
const {PDFDocument,PDFName,PDFDict}=require('pdf-lib');
const {checkAdobe,submitAdobe}=require('../src/services/adobePrintService');
const approved=hash=>({schemaVersion:1,status:'VALID',sha256:hash,signatures:[{status:'VALID',intact:true,cryptographicallyValid:true,trusted:true,coverage:'ENTIRE_FILE'}]});
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-adobe-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();
  const bytes=Buffer.from(await pdf.save()),file=path.join(dir,'Original invoice.pdf');fs.writeFileSync(file,bytes);
  return {dir,pdf,file,bytes,hash:crypto.createHash('sha256').update(bytes).digest('hex')};
}
test('Adobe dry run passes complete bytes and a single physical page without submitting',async t=>{
  const {file,hash,bytes}=await fixture(t);let job;
  const report=await submitAdobe({pdfPath:file,sha256:hash,page:2,verification:approved(hash),dryRun:true},{env:{},run:async(command,args,options)=>{
    assert.equal(command,'powershell.exe');assert.ok(args.includes('-STA'));assert.ok(args.includes('-DryRun'));assert.equal(options.windowsHide,true);assert.equal(options.shell,undefined);
    job=JSON.parse(fs.readFileSync(args[args.indexOf('-JobPath')+1]));
    assert.equal(job.page,2);assert.equal(job.sha256,hash);assert.deepEqual(fs.readFileSync(job.pdfPath),bytes);
    assert.equal(job.verification.sha256,hash);
    return {stdout:JSON.stringify({applicationVerified:true,readerValidated:null,validationSource:'application',prepared:true,submitted:false,page:2,copies:1,printer:'Default physical printer'})};
  }});
  assert.equal(report.submitted,false);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('Adobe failures distinguish pre-submission errors from uncertain Print invocation',async t=>{
  const {file,hash}=await fixture(t);
  for(const invoked of [false,true]) {
    await assert.rejects(submitAdobe({pdfPath:file,sha256:hash,page:1,verification:approved(hash)},{env:{},run:async(_command,args)=>{
      const jobPath=args[args.indexOf('-JobPath')+1];
      if(invoked)fs.writeFileSync(jobPath+'.state.json','{"phase":"invoking"}');
      throw Error('Timeout');
    }}),error=>error.beforeSubmission===!invoked);
  }
});
test('Adobe rejects incomplete success, invalid page requests and ambiguous logical page labels',async t=>{
  const {file,hash,pdf}=await fixture(t);
  await assert.rejects(submitAdobe({pdfPath:file,sha256:hash,page:1,verification:approved(hash)},{env:{},run:async()=>({stdout:JSON.stringify({submitted:true,page:1,copies:1,printer:'Printer'})})}),/Incomplete/);
  await assert.rejects(submitAdobe({pdfPath:file,sha256:hash,page:3,verification:approved(hash)},{run:()=>assert.fail('Must not open Reader')}),/Invalid Adobe print page/);
  pdf.catalog.set(PDFName.of('PageLabels'),PDFDict.withContext(pdf.context));
  const bytes=Buffer.from(await pdf.save());fs.writeFileSync(file,bytes);
  const updatedHash=crypto.createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(submitAdobe({pdfPath:file,sha256:updatedHash,page:1,verification:approved(updatedHash)},{run:()=>assert.fail('Must not open Reader')}),/custom page labels/);
});
test('Adobe readiness only probes the helper without opening or printing a PDF',async()=>{
  const ready=await checkAdobe({env:{ADOBE_READER:'C:\\Adobe\\Acrobat.exe'},run:async(command,args)=>{
    assert.equal(command,'powershell.exe');assert.ok(args.includes('-Check'));assert.ok(!args.includes('-JobPath'));
    return {stdout:JSON.stringify({ready:true,executable:'C:\\Adobe\\Acrobat.exe',printer:'Physical printer'})};
  }});
  assert.equal(ready.ready,true);
});
test('Adobe PowerShell controller parses on Windows without executing print commands',t=>{
  if(process.platform!=='win32')return t.skip('Windows PowerShell parser check');
  for(const name of ['adobe-print.ps1','adobe-ui.ps1','adobe-cleanup.ps1']) {
    const file=path.resolve('scripts',name).replace(/'/g,"''");
    const parsed=spawnSync('powershell.exe',['-NoProfile','-Command',`$adobeTokens=$null; $adobeErrors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$adobeTokens,[ref]$adobeErrors) | Out-Null; if($adobeErrors.Count){$adobeErrors | ForEach-Object {Write-Output $_.Message}; exit 1}`],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(parsed.status,0,parsed.stdout+parsed.stderr);
  }
});

test('Adobe worker errors retain their stage and run cleanup only before a Print invocation',async t=>{
  const {file,hash}=await fixture(t);let cleanupCalls=0;
  const progress=[];
  for(const invoked of [false,true]) {
    let resultPath;
    await assert.rejects(submitAdobe({pdfPath:file,sha256:hash,page:1,verification:approved(hash)},{env:{},onProgress:stage=>progress.push(stage),cleanup:async()=>{cleanupCalls++;},run:async(_command,args)=>{
      const jobPath=args[args.indexOf('-JobPath')+1];resultPath=jobPath+'.result.json';
      if(invoked)fs.writeFileSync(jobPath+'.state.json','{"phase":"invoking"}');
      throw Object.assign(Error('Worker failed'),{stdout:JSON.stringify({stage:'Selecting printer',error:'Printer selector unavailable'})});
    }}),error=>error.stage==='Selecting printer'&&error.beforeSubmission===!invoked);
    assert.equal(JSON.parse(fs.readFileSync(resultPath)).status,invoked?'UNCERTAIN':'FAILED');
  }
  assert.equal(cleanupCalls,1);assert.equal(progress.length,2);
});

test('Adobe progress is displayed while the worker is still running',async t=>{
  const {file,hash}=await fixture(t);const progress=[];
  await submitAdobe({pdfPath:file,sha256:hash,page:1,verification:approved(hash),dryRun:true},{env:{},onProgress:message=>progress.push(message),run:async(_command,args)=>{
    const jobPath=args[args.indexOf('-JobPath')+1];
    fs.writeFileSync(jobPath+'.progress.json',JSON.stringify({stage:'Opening Print dialog'}));
    await new Promise(resolve=>setTimeout(resolve,700));
    assert.ok(progress.includes('Opening Print dialog'));
    return {stdout:JSON.stringify({applicationVerified:true,readerValidated:null,prepared:true,submitted:false,page:1,copies:1,printer:'Physical printer'})};
  }});
});

test('Adobe cannot print without a complete application signature check bound to the PDF hash',async t=>{
  const {file,hash}=await fixture(t);
  const valid=approved(hash);
  for(const verification of [undefined,{...valid,status:'UNKNOWN'},{...valid,sha256:'different'},{...valid,signatures:[]},{...valid,signatures:[{...valid.signatures[0],trusted:false}]},{...valid,signatures:[{...valid.signatures[0],coverage:'ENTIRE_REVISION'}]}]) {
    await assert.rejects(submitAdobe({pdfPath:file,sha256:hash,page:1,verification},{run:()=>assert.fail('Unverified PDF must not open Reader')}),error=>error.beforeSubmission===true&&/application signature check/.test(error.message));
  }
});

test('Adobe diagnostic writes cached controls as JSON on Windows PowerShell',async t=>{
  if(process.platform!=='win32')return t.skip('Windows PowerShell diagnostic check');
  const {dir}=await fixture(t);
  const script=path.join(dir,'diagnostic-test.ps1'),output=path.join(dir,'diagnostic.json');
  const helper=path.resolve('scripts/adobe-ui.ps1').replace(/'/g,"''");
  fs.writeFileSync(script,`param([string]$OutputPath)\n$ErrorActionPreference='Stop'\n. '${helper}'\n$script:AdobeControlSnapshot=New-Object System.Collections.Generic.List[object]\n$script:AdobeControlSnapshot.Add(@{name='Reader toolbar';type='ControlType.ToolBar'})\nWrite-AdobeDiagnostic $OutputPath @(@{title='Reader';handle=1}) $null 'Opening Print dialog' 'Example failure'\n`);
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-OutputPath',output],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  const diagnostic=JSON.parse(fs.readFileSync(output,'utf8').replace(/^\uFEFF/,''));
  assert.equal(diagnostic.controls[0].name,'Reader toolbar');assert.equal(diagnostic.stage,'Opening Print dialog');
});
