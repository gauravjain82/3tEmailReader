const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Workbook}=require('./xlsx');
const {parseNormaPdf}=require('./parser');
const {SHEETS,checkHeaders,addInvoice,syncStock}=require('./workbook');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function loadConfig(file){
  const config=JSON.parse(fs.readFileSync(file,'utf8')),base=path.dirname(path.resolve(file));
  for(const key of ['pendingDirectory','doneDirectory','workbookPath','backupDirectory','reportDirectory']){if(typeof config[key]!=='string'||!config[key].trim())throw Error('Norma configuration requires '+key);config[key]=path.resolve(base,config[key]);}
  const inside=(a,b)=>{const rel=path.relative(a,b);return rel===''||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
  if(inside(config.pendingDirectory,config.doneDirectory)||inside(config.doneDirectory,config.pendingDirectory))throw Error('Norma Pending and Done must be separate, non-nested folders');
  if(inside(config.pendingDirectory,config.workbookPath)||inside(config.doneDirectory,config.workbookPath))throw Error('Keep the Norma workbook outside Pending and Done');
  if(path.extname(config.workbookPath).toLowerCase()!=='.xlsx')throw Error('Norma workbook must be an .xlsx file');
  return config;
}
function commitWorkbook(config,original,book){
  if(!book.dirty)return null;
  const destination=config.workbookPath,folder=path.dirname(destination),temp=path.join(folder,'.norma-'+crypto.randomUUID()+'.tmp');
  if(fs.existsSync(path.join(folder,'~$'+path.basename(destination))))throw Error('Close the Norma workbook in Excel before running the parser');
  const bytes=book.pack();new Workbook(bytes); // Validate the package before replacing the workbook.
  fs.mkdirSync(config.backupDirectory,{recursive:true});
  const backup=path.join(config.backupDirectory,path.basename(destination,'.xlsx')+'-'+Date.now()+'-'+crypto.randomUUID().slice(0,8)+'.xlsx');
  try{
    const fd=fs.openSync(temp,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    if(hash(fs.readFileSync(destination))!==hash(original))throw Error('Norma workbook changed during processing; retry after closing Excel');
    fs.writeFileSync(backup,original,{flag:'wx'});
    fs.renameSync(temp,destination);
    return backup;
  }finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function moveToDone(file,bytes,done){
  if(hash(fs.readFileSync(file))!==hash(bytes))throw Error('Pending PDF changed after parsing; left in Pending');
  const name=path.basename(file),ext=path.extname(name),stem=name.slice(0,-ext.length);
  for(let number=1;number<=10000;number++){
    const dest=path.join(done,stem+(number===1?'':` (${number})`)+ext);
    try{const fd=fs.openSync(dest,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(error){if(error.code!=='EEXIST')throw error;if(hash(fs.readFileSync(dest))!==hash(bytes))continue;}
    if(hash(fs.readFileSync(file))!==hash(bytes))throw Error('Pending PDF changed before archival; original saved in Done, updated file kept in Pending');
    fs.unlinkSync(file);return dest;
  }throw Error('Too many same-named PDFs in Done');
}
async function runNorma(config,{throughDate=today(),log=console.log,parsePdf=parseNormaPdf,archive=moveToDone}={}){
  if(!fs.existsSync(config.workbookPath))throw Error('Norma workbook not found: '+config.workbookPath+'. Copy your stock workbook here or update workbookPath in the Norma config.');
  for(const folder of [config.pendingDirectory,config.doneDirectory,config.reportDirectory])fs.mkdirSync(folder,{recursive:true});
  const lock=config.workbookPath+'.norma.lock';let fd;
  try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,host:require('os').hostname(),startedAt:new Date().toISOString()}));}catch(error){if(error.code==='EEXIST')throw Error('Another Norma run is active, or a previous run left '+lock+'. Close the other run before removing a stale lock.');throw error;}
  const report={startedAt:new Date().toISOString(),throughDate,workbookPath:config.workbookPath,files:[],backups:[],stock:[],errors:[]};
  const reportPath=path.join(config.reportDirectory,new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8)+'.json');
  const saveReport=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  try{
    const files=fs.readdirSync(config.pendingDirectory,{withFileTypes:true}).filter(f=>f.isFile()&&/\.pdf$/i.test(f.name)).map(f=>path.join(config.pendingDirectory,f.name)).sort();
    log('Norma workbook:',config.workbookPath);log('Norma Pending folder:',config.pendingDirectory);log('PDF files found:',files.length);
    if(!files.length)log('No PDF files found directly in Pending. Daily stock will be checked; no new sales rows will be added.');
    const parsed=[];
    for(const file of files){try{const bytes=fs.readFileSync(file),invoices=await parsePdf(bytes);parsed.push({file,bytes,invoices});}catch(error){const entry={file,status:'FAILED',error:error.message};report.files.push(entry);report.errors.push(entry);log('Norma PDF kept in Pending:',path.basename(file),error.message);}}
    const allParts=[...new Set(parsed.flatMap(p=>p.invoices.flatMap(i=>i.items.map(item=>item.partNumber))))];
    for(const item of parsed){
      const entry={file:item.file,sha256:hash(item.bytes),invoices:item.invoices,status:'PROCESSING'};report.files.push(entry);
      try{
        const original=fs.readFileSync(config.workbookPath),book=new Workbook(original);checkHeaders(book);
        const changes=item.invoices.map(i=>addInvoice(book,i));
        const affected={gurgaon:[],gujarat:[]};changes.forEach((c,index)=>{if(c.status==='ADDED')affected[item.invoices[index].region].push(item.invoices[index].date);});
        if(item.invoices.some(i=>i.date>throughDate))throw Error('Invoice date is after the stock processing date');
        entry.sales=changes;entry.stock=syncStock(book,{affected,throughDate,extraParts:allParts,openingBalances:config.openingBalances});
        const added=changes.findIndex(c=>c.status==='ADDED');if(added>=0)book.focus(SHEETS[item.invoices[added].region],changes[added].rows[0]);
        const backup=commitWorkbook(config,original,book);if(backup)report.backups.push(backup);
        log('Norma stock: openings read from latest dated worksheet entries:',entry.stock.openingSources.length);
        entry.donePath=archive(item.file,item.bytes,config.doneDirectory);entry.status='DONE';
        log('Norma saved:',path.basename(item.file),changes.map((c,index)=>c.invoiceNumber+' '+c.status+'; sheet "'+SHEETS[item.invoices[index].region]+'", row(s) '+c.rows.join(', ')).join(' | '));
      }catch(error){entry.status='FAILED';entry.error=error.message;report.errors.push({file:item.file,error:error.message});log('Norma PDF kept in Pending:',path.basename(item.file),error.message);}
      saveReport();
    }
    if(!parsed.length&&!files.length){const original=fs.readFileSync(config.workbookPath),book=new Workbook(original);checkHeaders(book);const stock=syncStock(book,{throughDate,openingBalances:config.openingBalances});report.stock.push(stock);const backup=commitWorkbook(config,original,book);if(backup)report.backups.push(backup);log('Norma stock: openings read from latest dated worksheet entries:',stock.openingSources.length);}
    report.completedAt=new Date().toISOString();saveReport();log('Norma workbook output:',config.workbookPath);log('Norma report:',reportPath);return {...report,reportPath};
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
async function main(){
  const args=process.argv.slice(2);let file=path.resolve(__dirname,'../../norma/config.json'),date;
  for(let i=0;i<args.length;i+=2){if(!args[i+1])throw Error('Usage: npm run norma -- [--config PATH] [--date YYYY-MM-DD]');if(args[i]==='--config')file=path.resolve(args[i+1]);else if(args[i]==='--date')date=args[i+1];else throw Error('Unknown Norma option: '+args[i]);}
  if(!fs.existsSync(file)){if(file!==path.resolve(__dirname,'../../norma/config.json'))throw Error('Norma configuration not found: '+file);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.resolve(__dirname,'../../norma/config.example.json'),file);console.log('Created Norma configuration:',file);}
  const report=await runNorma(loadConfig(file),date?{throughDate:date}:{});if(report.errors.length)process.exitCode=1;
}
if(require.main===module)main().catch(error=>{console.error('Norma service:',error.message);process.exitCode=1;});
module.exports={loadConfig,runNorma,commitWorkbook,moveToDone};
