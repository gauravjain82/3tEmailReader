const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {spawnSync}=require('child_process');
const {PDFDocument,PDFName,PDFDict}=require('pdf-lib');
const {checkAdobe,submitAdobe}=require('../src/services/adobePrintService');
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-adobe-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();
  const bytes=Buffer.from(await pdf.save()),file=path.join(dir,'Original invoice.pdf');fs.writeFileSync(file,bytes);
  return {dir,pdf,file,bytes,hash:crypto.createHash('sha256').update(bytes).digest('hex')};
}
test('Adobe dry run passes complete bytes and a single physical page without submitting',async t=>{
  const {file,hash,bytes}=await fixture(t);let job;
  const report=await submitAdobe({pdfPath:file,sha256:hash,page:2,dryRun:true},{env:{},run:async(command,args,options)=>{
    assert.equal(command,'powershell.exe');assert.ok(args.includes('-STA'));assert.ok(args.includes('-DryRun'));assert.equal(options.windowsHide,true);assert.equal(options.shell,undefined);
    job=JSON.parse(fs.readFileSync(args[args.indexOf('-JobPath')+1]));
    assert.equal(job.page,2);assert.equal(job.sha256,hash);assert.deepEqual(fs.readFileSync(job.pdfPath),bytes);
    return {stdout:JSON.stringify({readerValidated:true,prepared:true,submitted:false,page:2,copies:1,printer:'Default physical printer'})};
  }});
  assert.equal(report.submitted,false);assert.deepEqual(fs.readFileSync(file),bytes);
});
test('Adobe failures distinguish pre-submission errors from uncertain Print invocation',async t=>{
  const {file,hash}=await fixture(t);
  for(const invoked of [false,true]) {
    await assert.rejects(submitAdobe({pdfPath:file,sha256:hash,page:1},{env:{},run:async(_command,args)=>{
      const jobPath=args[args.indexOf('-JobPath')+1];
      if(invoked)fs.writeFileSync(jobPath+'.state.json','{"phase":"invoking"}');
      throw Error('Timeout');
    }}),error=>error.beforeSubmission===!invoked);
  }
});
test('Adobe rejects incomplete success, invalid page requests and ambiguous logical page labels',async t=>{
  const {file,hash,pdf}=await fixture(t);
  await assert.rejects(submitAdobe({pdfPath:file,sha256:hash,page:1},{env:{},run:async()=>({stdout:JSON.stringify({submitted:true,page:1,copies:1,printer:'Printer'})})}),/Incomplete/);
  await assert.rejects(submitAdobe({pdfPath:file,sha256:hash,page:3},{run:()=>assert.fail('Must not open Reader')}),/Invalid Adobe print page/);
  pdf.catalog.set(PDFName.of('PageLabels'),PDFDict.withContext(pdf.context));
  const bytes=Buffer.from(await pdf.save());fs.writeFileSync(file,bytes);
  await assert.rejects(submitAdobe({pdfPath:file,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),page:1},{run:()=>assert.fail('Must not open Reader')}),/custom page labels/);
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
  const file=path.resolve('scripts/adobe-print.ps1').replace(/'/g,"''");
  const parsed=spawnSync('powershell.exe',['-NoProfile','-Command',`$adobeTokens=$null; $adobeErrors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$adobeTokens,[ref]$adobeErrors) | Out-Null; if($adobeErrors.Count){$adobeErrors | ForEach-Object {Write-Output $_.Message}; exit 1}`],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(parsed.status,0,parsed.stdout+parsed.stderr);
});
