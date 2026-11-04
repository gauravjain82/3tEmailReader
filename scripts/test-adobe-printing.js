require('dotenv').config({quiet:true});
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const readline=require('node:readline/promises');
const {checkAdobe,submitAdobe}=require('../src/services/adobePrintService');
const {verifyPdfSignature}=require('../src/services/signatureVerificationService');
const {attachmentFilename}=require('../src/storage/attachmentPaths');
(async()=>{
  await checkAdobe();
  const prompt=readline.createInterface({input:process.stdin,output:process.stdout});
  let input;
  try {input=(process.argv[2]||await prompt.question('Paste the full path of a signed invoice PDF: ')).trim().replace(/^"(.*)"$/,'$1');}finally{prompt.close();}
  if(!/\.pdf$/i.test(input))throw Error('Choose a signed PDF invoice');
  const bytes=fs.readFileSync(input),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  const dir=path.resolve(__dirname,'../data/verification','adobe-dry-run-'+crypto.randomUUID());
  fs.mkdirSync(dir,{recursive:true});const pdfPath=path.join(dir,attachmentFilename(input));fs.writeFileSync(pdfPath,bytes);
  const verification=await verifyPdfSignature(pdfPath,sha256);
  fs.writeFileSync(path.join(dir,'signature.json'),JSON.stringify(verification,null,2));
  if(verification.status!=='VALID')throw Error('Test blocked by signature verification: '+verification.reason);
  const report=await submitAdobe({pdfPath,sha256,page:1,verification,dryRun:true});
  fs.writeFileSync(path.join(dir,'adobe-dry-run.json'),JSON.stringify(report,null,2));
  console.log('PASS: Application signature checks, Windows default printer, page 1 and one copy confirmed. No Print click was made.');
  console.log('Report:',dir);
})().catch(error=>{console.error('Adobe test:',error.message);if(error.resultPath)console.error('Diagnostic result:',error.resultPath);process.exitCode=1;});
