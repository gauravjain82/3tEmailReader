// This file uses Node built-ins only: it must work before npm dependencies exist.
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const readline=require('node:readline/promises');
const {acquireRunLock}=require('../src/services/runLock');
const {findPython312,inspectPython,supportedRuntime,ensurePythonEnvironment}=require('./python-runtime');
const {setupHandwriting}=require('./setup-handwriting');
const handwritingModel=require('./handwriting-model.json');
const {checkCertificates}=require('./check-certificates');
const root=path.resolve(__dirname,'..');

function probe(command,args,projectRoot=root) {
  const r=spawnSync(command,args,{cwd:projectRoot,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:128*1024});
  return {ok:r.status===0,text:((r.stdout||'')+'\n'+(r.stderr||'')).trim()};
}
function execute(command,args,projectRoot=root) {
  const r=spawnSync(command,args,{cwd:projectRoot,stdio:'inherit',windowsHide:true});
  if(r.error || r.status!==0)throw Error('Setup command failed. Review the output above and the troubleshooting section in SETUP.md.');
}
function supportedNode(version) {const m=String(version).match(/^v?(\d+)\.(\d+)/);return !!m && (Number(m[1])===24 || Number(m[1])===22 && Number(m[2])>=3);}
function supportedPython(text) {const m=String(text).match(/Python (\d+)\.(\d+)/);return !!m && Number(m[1])===3 && Number(m[2])===12;}
function readJson(file) {try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function settings(projectRoot,env) {
  const result={...env};
  const file=path.join(projectRoot,'.env');
  if(fs.existsSync(file))for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    const m=line.match(/^\s*(SUMATRA_PDF|SIGNATURE_PYTHON|SIGNATURE_TRUST_DIR|SIGNATURE_ALLOW_LEGACY_SHA1|PRINT_ENGINE|ADOBE_READER)\s*=\s*(.*?)\s*$/);
    if(m && !result[m[1]])result[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');
  }
  return result;
}
function ensureLocalFiles(projectRoot) {
  const created=[];
  if(!fs.existsSync(path.join(projectRoot,'.env'))) {fs.copyFileSync(path.join(projectRoot,'.env.example'),path.join(projectRoot,'.env'),fs.constants.COPYFILE_EXCL);created.push('.env');}
  if(!fs.existsSync(path.join(projectRoot,'config.json'))) {
    const example=readJson(path.join(projectRoot,'config.example.json')) || {};
    fs.writeFileSync(path.join(projectRoot,'config.json'),JSON.stringify({...example,allowedSenders:[],firstRunAfter:null},null,2),{flag:'wx'});created.push('config.json');
  }
  return created;
}
function updateSenders(projectRoot,input) {
  const {validateConfig}=require('../src/config');
  const file=path.join(projectRoot,'config.json');
  const old=readJson(file) || {firstRunAfter:null};
  const updated={...old,allowedSenders:input.split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean)};
  validateConfig(updated);
  if(fs.existsSync(file)) {
    const backup=path.join(projectRoot,'data','backups',`setup-${Date.now()}-${require('crypto').randomUUID()}`);
    fs.mkdirSync(backup,{recursive:true});fs.copyFileSync(file,path.join(backup,'config.json'));
  }
  const temporary=file+'.setup.tmp';fs.writeFileSync(temporary,JSON.stringify(updated,null,2));fs.renameSync(temporary,file);
}
function collectStatus(projectRoot=root,{run=probe,env=process.env,version=process.version,platform=process.platform}={}) {
  const configured=settings(projectRoot,env);
  const certificateCheck=checkCertificates(projectRoot,{trustDir:configured.SIGNATURE_TRUST_DIR||path.join(projectRoot,'certificates','trusted-roots')});
  const legacyAdapter=['verify_pdf_signature.py','legacy_pdf_signature.py'].every(file=>fs.existsSync(path.join(projectRoot,'scripts',file)));
  const credentials=readJson(path.join(projectRoot,'credentials.json'));const client=credentials?.installed || credentials?.web;
  const token=readJson(path.join(projectRoot,'token.json'));
  const senderConfig=readJson(path.join(projectRoot,'config.json'));
  let senders=false;
  try {const {validateConfig}=require('../src/config');const parsed=validateConfig(senderConfig || {});senders=!parsed.allowedSenders.some(s=>/@example\.(com|org|net|test)$/i.test(s));}catch{}
  const dependencies=run(process.execPath,['-e',"const D=require('better-sqlite3');const d=new D(':memory:');d.close();require('pdf-parse');require('pdf-lib');require('googleapis');require('dotenv');"],projectRoot).ok;
  const verifier=configured.SIGNATURE_PYTHON || path.join(projectRoot,'.signature-venv',platform==='win32'?'Scripts/python.exe':'bin/python');
  const signaturePython=fs.existsSync(verifier)?inspectPython(verifier,projectRoot,{run}):null;
  const handwritingExecutable=path.join(projectRoot,'.handwriting-venv',platform==='win32'?'Scripts/python.exe':'bin/python');
  const handwritingPython=fs.existsSync(handwritingExecutable)?inspectPython(handwritingExecutable,projectRoot,{run}):null;
  let pythonInfo=supportedRuntime(signaturePython)?signaturePython:supportedRuntime(handwritingPython)?handwritingPython:null;
  if(!pythonInfo)try{pythonInfo=inspectPython(findPython312(projectRoot,{run,env}),projectRoot,{run});}catch{}
  const signatureVerifier=supportedRuntime(signaturePython) && run(verifier,['-c',"from importlib.metadata import version; assert version('pyHanko')=='0.33.0'"],projectRoot).ok;
  const rejectionDependencies=run(process.execPath,['-e',"require('pdf-parse');require('pdfjs-dist/package.json');require('@napi-rs/canvas');require('tesseract.js');require('@tesseract.js-data/eng');"],projectRoot).ok;
  const handwritingDependencies=supportedRuntime(handwritingPython)&&run(handwritingExecutable,['-c',"import os; os.environ['HF_HUB_OFFLINE']='1'; os.environ['TRANSFORMERS_OFFLINE']='1'; import torch; from transformers import TrOCRProcessor,VisionEncoderDecoderModel; from PIL import Image; from importlib.metadata import version; assert version('torch').split('+')[0]=='2.9.1'; assert version('transformers')=='4.57.1'; assert version('Pillow')=='12.0.0'; assert version('safetensors')=='0.6.2'"],projectRoot).ok;
  const modelDir=path.join(projectRoot,'rejections','models','trocr-base-handwritten'),modelSource=readJson(path.join(modelDir,'source.json'));
  const handwritingModelReady=modelSource?.model===handwritingModel.id&&modelSource?.revision===handwritingModel.revision&&handwritingModel.requiredFiles.every(name=>{try{return fs.statSync(path.join(modelDir,name)).isFile()&&fs.statSync(path.join(modelDir,name)).size>0;}catch{return false;}});
  const pythonVersionsMatch=supportedRuntime(signaturePython)&&supportedRuntime(handwritingPython)&&signaturePython.version.join('.')===handwritingPython.version.join('.');
  const candidates=[configured.SUMATRA_PDF,configured.LOCALAPPDATA && path.join(configured.LOCALAPPDATA,'SumatraPDF','SumatraPDF.exe'),configured.ProgramFiles && path.join(configured.ProgramFiles,'SumatraPDF','SumatraPDF.exe'),configured['ProgramFiles(x86)'] && path.join(configured['ProgramFiles(x86)'],'SumatraPDF','SumatraPDF.exe')].filter(Boolean);
  const sumatra=candidates.some(f=>path.isAbsolute(f) && /\.exe$/i.test(f) && fs.existsSync(f));
  // Ignore obsolete PRINT_ENGINE=adobe values retained in existing local .env files.
  const printEngine='sumatra';
  let printer={name:'Not checked',valid:false,physical:false};
  if(platform==='win32') {
    const result=run('powershell.exe',['-NoProfile','-Command',"Add-Type -AssemblyName System.Drawing; $invoiceSetupPrinter=New-Object System.Drawing.Printing.PrinterSettings; @{name=$invoiceSetupPrinter.PrinterName;valid=$invoiceSetupPrinter.IsValid}|ConvertTo-Json -Compress"],projectRoot);
    if(result.ok)try {const p=JSON.parse(result.text);printer={name:p.name,valid:!!p.valid,physical:!!p.valid && !/PDF|XPS|OneNote|Fax/i.test(p.name)};}catch{}
  }
  const status={node:supportedNode(version),nodeVersion:version,dependencies,senders,credentials:!!(client?.client_id && client?.client_secret),gmailToken:!!(token?.refresh_token || token?.access_token && (!token.expiry_date || token.expiry_date>Date.now())),python:supportedRuntime(pythonInfo),pythonVersion:pythonInfo?.version?.join('.')||'Not found',signaturePythonVersion:signaturePython?.version?.join('.')||'Not installed',handwritingPythonVersion:handwritingPython?.version?.join('.')||'Not installed',pythonVersionsMatch:!!pythonVersionsMatch,signatureVerifier:!!signatureVerifier,rejectionDependencies,handwritingDependencies:!!handwritingDependencies,handwritingModel:!!handwritingModelReady,sumatra,printer};
  status.extractionReady=status.node && status.dependencies && status.senders && status.credentials && status.gmailToken;
  status.certificateCheck=certificateCheck;
  status.certificates=certificateCheck.ready;
  status.legacyAdapter=legacyAdapter;
  status.legacySha1Enabled=configured.SIGNATURE_ALLOW_LEGACY_SHA1==='true';
  status.printEngine=printEngine;
  status.printingPrerequisitesReady=status.extractionReady && status.sumatra && status.printer.physical;
  status.localRejectionReady=status.node&&status.rejectionDependencies;
  status.localHandwritingReady=status.localRejectionReady&&status.handwritingDependencies&&status.handwritingModel;
  return status;
}
function showStatus(status) {
  console.log('\nMachine setup checks:');
  for(const [key,label] of Object.entries({node:'Node.js 22/24',dependencies:'Node dependencies and SQLite binary',senders:'Configured sender addresses',credentials:'Gmail OAuth client file',gmailToken:'Gmail connection token',sumatra:'SumatraPDF printing',rejectionDependencies:'Local rejection parser / Windows-Tesseract OCR packages',handwritingDependencies:'Local handwriting Python packages (optional for Gmail/printing)',handwritingModel:'Local TrOCR model files (optional for Gmail/printing)'}))console.log(`  ${status[key]?'OK':'ACTION NEEDED'}  ${label}`);
  console.log('  Handwriting Python (optional):',status.handwritingPythonVersion);
  console.log('  Printing: SumatraPDF, without digital signature verification. Python/certificates/Adobe are not required for Gmail or printing.');
  console.log('  Default printer:',status.printer.name,status.printer.physical?'(physical printer selected)':'(select your physical printer in Windows Settings)');
  console.log(status.extractionReady?'\nExtraction prerequisites are ready.':'\nExtraction setup still needs the items marked above.');
  console.log(status.printingPrerequisitesReady?'SumatraPDF printing prerequisites are ready.':'Printing prerequisites still need attention; see SETUP.md.');
  console.log(status.localHandwritingReady?'Local rejection parser and handwriting model prerequisites are ready.':'For local rejection handwriting setup, run Setup Handwriting OCR.cmd or choose it during Setup.cmd.');
  console.log('No Gmail messages were read and no print jobs were sent by these checks.');
}
function findNpm(projectRoot=root) {
  const candidates=[path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')];
  const found=probe('where.exe',['npm.cmd'],projectRoot);
  if(found.ok)for(const command of found.text.split(/\r?\n/))candidates.push(path.join(path.dirname(command),'node_modules','npm','bin','npm-cli.js'));
  const npm=candidates.find(f=>fs.existsSync(f));if(!npm)throw Error('npm is missing. Reinstall Node.js with npm selected. See SETUP.md.');return npm;
}
function setupSignatures(projectRoot=root,{pythonCommand=findPython312(projectRoot),run=probe,exec=execute}={}) {
  const environment=ensurePythonEnvironment(projectRoot,'.signature-venv',pythonCommand,{run,execute:exec});
  const executable=environment.executable;
  console.log('Signature Python:',environment.version,'64-bit (shared selected runtime)');
  exec(executable,['-c',"import sys,struct; print('Verifier Python:',sys.version.split()[0],str(struct.calcsize('P')*8)+'-bit')"],projectRoot);
  exec(executable,['-m','pip','install','--upgrade','pip'],projectRoot);
  try {
    // Repair incomplete/source-built PyYAML installs and avoid local C/Cython/Rust builds.
    exec(executable,['-m','pip','install','--only-binary=:all:','--force-reinstall','PyYAML==6.0.3'],projectRoot);
    exec(executable,['-m','pip','install','--only-binary=:all:','-r',path.join(projectRoot,'requirements-signatures.txt')],projectRoot);
  } catch {
    throw Error('Prebuilt signature packages could not be installed. Use standard 64-bit Python 3.12 and a package index that provides wheels. Check the displayed Verifier Python version, which may differ from system Python. See SETUP.md; do not install Cython/build tools just to bypass this error.');
  }
  exec(executable,['-c',"import yaml; assert yaml.__version__=='6.0.3'; print('PyYAML wheel import succeeded.')"],projectRoot);
  exec(executable,['-c',"from importlib.metadata import version; assert version('pyHanko')=='0.33.0'; print('Signature verifier is installed.')"],projectRoot);
  fs.mkdirSync(path.join(projectRoot,'certificates','trusted-roots'),{recursive:true});
}
function repairSignatures(projectRoot=root,{find=findPython312,install=setupSignatures}={}) {
  const pythonCommand=find(projectRoot); // Locate the correct interpreter before moving anything.
  console.log('Repair will use:',pythonCommand);
  const environment=path.resolve(projectRoot,'.signature-venv');
  if(fs.existsSync(environment)) {
    const backup=path.resolve(projectRoot,'data','backups',`signature-venv-${Date.now()}-${require('crypto').randomUUID()}`);
    if(path.dirname(environment)!==path.resolve(projectRoot) || !backup.startsWith(path.resolve(projectRoot,'data','backups')+path.sep))throw Error('Invalid environment backup path');
    fs.mkdirSync(path.dirname(backup),{recursive:true});
    fs.renameSync(environment,backup);
    console.log('Previous verifier environment preserved at:',backup);
  }
  install(projectRoot,{pythonCommand});
  const configured=settings(projectRoot,process.env).SIGNATURE_PYTHON;
  if(configured)console.log('Check your SIGNATURE_PYTHON override; the repaired interpreter is:',path.join(environment,'Scripts','python.exe'));
  console.log('Signature setup repair complete. Invoice data and Gmail settings were retained.');
}
async function main(args=process.argv.slice(2)) {
  if(args.length>1 || args.some(a=>!['--check','--signatures','--repair-signatures'].includes(a)))throw Error('Usage: node scripts/setup.js [--check | --signatures | --repair-signatures]');
  if(args[0]==='--check') {const status=collectStatus();showStatus(status);if(!status.extractionReady)process.exitCode=1;return;}
  if(process.platform!=='win32')throw Error('This setup launcher is for Windows PCs. See SETUP.md.');
  if(!supportedNode(process.version))throw Error('Install Node.js 22.x or 24.x. Your Node version is '+process.version+'. See SETUP.md.');
  if(args[0]==='--repair-signatures') {const release=acquireRunLock(path.join(root,'data'));try{repairSignatures();}finally{release();}return;}
  if(args[0]==='--signatures') {const release=acquireRunLock(path.join(root,'data'));try{setupSignatures();}finally{release();}return;}
  if(!process.stdin.isTTY) {showStatus(collectStatus());return;}
  const prompt=readline.createInterface({input:process.stdin,output:process.stdout});let release,releaseRejections,pythonCommand;
  try {
    console.log('\n3tEmailReader - setup on this Windows PC\n1. Install/configure this machine\n2. Check current setup only\n3. Cancel');
    const choice=(await prompt.question('Choose [1/2/3], Enter to cancel: ')).trim();
    if(choice==='2'){showStatus(collectStatus());return;}
    if(choice!=='1'){console.log('Setup cancelled.');return;}
    release=acquireRunLock(path.join(root,'data'));
    releaseRejections=acquireRunLock(path.join(root,'rejections'));
    console.log('\nStep 1/7 - Install Node dependencies (internet required). Existing invoice data is retained.');
    const npm=findNpm();execute(process.execPath,[npm,'ci','--no-fund']);
    console.log('\nStep 2/7 - Local settings. Existing .env/config files are retained.');
    const created=ensureLocalFiles(root);console.log(created.length?'Created: '+created.join(', '):'Existing settings found.');
    const input=(await prompt.question('Enter allowed sender addresses separated by commas, or Enter to keep current settings: ')).trim();
    if(input)updateSenders(root,input);
    console.log('\nStep 3/7 - Locate optional 64-bit Python 3.12 for local handwriting OCR. Gmail/printing do not require Python.');
    try {pythonCommand=findPython312(root);}catch{console.log('Optional handwriting Python was not found. Gmail and SumatraPDF printing can still be used.');}
    console.log('\nStep 4/7 - Local rejection invoices and handwriting model.');
    fs.mkdirSync(path.join(root,'rejections','input'),{recursive:true});
    console.log('The local handwriting model uses Python 3.12 in its own environment.');
    const handwriting=(await prompt.question('Install local handwriting OCR on this PC? Model download about 1.3 GB plus packages. [Y/n]: ')).trim().toLowerCase();
    if(!['n','no'].includes(handwriting))try{
      if(!pythonCommand)pythonCommand=findPython312(root);
      setupHandwriting(root,{pythonCommand});
    }catch(error){console.log(error.message);console.log('Retry this step with Setup Handwriting OCR.cmd. Printed PDF fields can still be parsed without the model.');}
    console.log('\nStep 5/7 - Gmail credentials. Place your Desktop OAuth file as credentials.json beside Setup.cmd.');
    let status=collectStatus();
    if(!status.credentials) {await prompt.question('See SETUP.md for Google Cloud steps. Press Enter after placing credentials.json, or to continue without it: ');status=collectStatus();}
    if(status.credentials && !status.gmailToken) {
      const connect=(await prompt.question('Connect Gmail on this PC now? [y/N]: ')).trim().toLowerCase();
      if(['y','yes'].includes(connect))execute(process.execPath,[npm,'run','auth']);
    }
    console.log('\nStep 6/7 - Printing. Select your attached printer as Windows default.');
    console.log('SumatraPDF: https://www.sumatrapdfreader.org/download-free-pdf-viewer');
    console.log('A virtual PDF printer is not a physical print destination. No test page is sent by setup.');
    console.log('\nStep 7/7 - Final machine checks.');showStatus(collectStatus());
    console.log('\nNext: double-click Run Invoice Extractor.cmd. The first run reads the last 24 hours.');
    console.log('Printing uses SumatraPDF without digital signature checks. Old Adobe/verification .env settings are ignored.');
    console.log('For local PDFs: place rejection invoices in rejections/input and double-click Parse Rejection Invoices.cmd.');
  } finally {releaseRejections?.();release?.();prompt.close();}
}
if(require.main===module)main().catch(e=>{console.error('Setup error:',e.message);process.exitCode=1;});
module.exports={supportedNode,supportedPython,ensureLocalFiles,updateSenders,collectStatus,findPython312,repairSignatures,setupSignatures};
