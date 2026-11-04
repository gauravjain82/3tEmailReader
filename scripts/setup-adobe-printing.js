require('dotenv').config({quiet:true});
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {checkAdobe}=require('../src/services/adobePrintService');
const root=path.resolve(__dirname,'..');
(async()=>{
  if(process.platform!=='win32')throw Error('Adobe desktop printing requires Windows');
  const ready=await checkAdobe();
  const file=path.join(root,'.env');
  const previous=fs.existsSync(file)?fs.readFileSync(file,'utf8'):fs.readFileSync(path.join(root,'.env.example'),'utf8');
  if(fs.existsSync(file)) {
    const backup=path.join(root,'data','backups','adobe-setup-'+crypto.randomUUID());
    fs.mkdirSync(backup,{recursive:true});fs.copyFileSync(file,path.join(backup,'.env'));
  }
  const lines=previous.split(/\r?\n/).filter(line=>!/^\s*PRINT_ENGINE\s*=/.test(line));
  fs.writeFileSync(file,lines.join('\n').replace(/\s*$/,'')+'\nPRINT_ENGINE=adobe\n');
  console.log('Adobe printing enabled. Reader:',ready.executable,'Version:',ready.version);
  console.log('Windows default printer:',ready.printer);
  console.log('In Reader: Preferences > Signatures > Verification > More > enable Verify signatures when the document is opened.');
  console.log('Use the English desktop Reader UI. Close Reader before each batch and leave the desktop unlocked.');
  console.log('Run Test Adobe Printing.cmd with one signed invoice first. It prepares the dialog without clicking Print.');
  console.log('Then choose Print originals in the extractor. Adobe must report all signatures valid before automation submits one page and one copy.');
  console.log('To restore SumatraPDF, set PRINT_ENGINE=sumatra in .env.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
