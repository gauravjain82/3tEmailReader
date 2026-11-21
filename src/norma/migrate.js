const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Workbook}=require('./xlsx');
const {validDate}=require('../pdf/validators/invoiceValidator');
const {SHEETS,checkHeaders,stockBlocks,latestClosing,salesRows}=require('./workbook');
const {LEDGER,OPENINGS,initializeSheets,syncLedger,verifyLedger,salesTotals,units,qty,label,archiveLegacyDateErrors}=require('./ledger');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function migrateWorkbook(bytes,{fromDate,throughDate=today(),openingBalances={}}){
  if(!validDate(fromDate)||!validDate(throughDate)||fromDate>throughDate)throw Error('Migration requires a valid --from date on or before --date');
  const book=new Workbook(bytes),scratch=new Workbook(bytes);checkHeaders(book);
  const excludedLegacyDateRows=archiveLegacyDateErrors(book,fromDate),totals=salesTotals(book,{fromDate}),source=scratch.sheet(SHEETS.stock),recoveries=[],seeds=[],movements=[],warnings=[];
  if(excludedLegacyDateRows.length)warnings.push(excludedLegacyDateRows.length+' historical rows have invalid dates and are fingerprinted in STOCK LEGACY SALES; original values are preserved, no dates guessed');
  for(const region of ['gurgaon','gujarat']){
    const blocks=stockBlocks(source,region),parts=new Set(blocks.filter(b=>b.date<fromDate).flatMap(b=>[...b.parts.keys()]));
    if(!parts.size)throw Error('No earlier verified stock baseline for '+region+' before '+fromDate);
    // Use the last physical block on repeated dates, matching the legacy rule.
    const selected=new Map();for(const block of blocks)selected.set(block.date,block);
    const historySales=salesRows(scratch,region);
    for(const part of parts){
      const previous=latestClosing(source,blocks,{region,part,beforeDate:fromDate});let balance=previous.quantity;
      // A part may be absent from intermediate daily blocks. Account for sales
      // on those days instead of treating its older closing as today's opening.
      for(const entry of historySales)if(entry.part===part&&entry.date>previous.sourceDate&&entry.date<fromDate)balance-=units(entry.qty,'historical sales row '+entry.row);
      seeds.push({date:fromDate,region,part,quantity:balance,sourceDate:previous.sourceDate,sourceCell:previous.sourceCell});
    }
    const cols=region==='gurgaon'?{received:'D',transfer:'E'}:{received:'L',transit:'O'};
    for(const block of selected.values()){
      if(block.date<fromDate)continue;
      for(const [part,row] of block.parts){const values={};for(const [field,col] of Object.entries(cols)){
        const ref=col+row,raw=source.value(ref);if(source.cells.get(ref)?.getAttribute('t')==='e'||(source.formula(ref)&&raw===''))throw Error('Cannot migrate invalid manual movement '+SHEETS.stock+'!'+ref);
        values[field]=raw===''?'':qty(units(raw,SHEETS.stock+'!'+ref));
      }movements.push({date:block.date,region,part,...values});}
    }
  }
  initializeSheets(book);const openingSheet=book.sheet(OPENINGS),sheet=book.sheet(LEDGER);
  seeds.sort((a,b)=>(a.region+':'+a.part).localeCompare(b.region+':'+b.part)).forEach((seed,index)=>{[seed.date,label(seed.region),seed.part,qty(seed.quantity),`Verified saved closing: ${seed.sourceDate}, ${SHEETS.stock}!${seed.sourceCell}; intervening sales deducted`].forEach((value,col)=>openingSheet.set(String.fromCharCode(65+col)+(index+2),value));});
  movements.sort((a,b)=>(a.date+':'+a.region+':'+a.part).localeCompare(b.date+':'+b.region+':'+b.part)).forEach((entry,index)=>{
    const row=index+2;for(const [col,value] of Object.entries({A:entry.date,B:label(entry.region),C:entry.part,E:entry.received,F:entry.transfer??'',I:entry.transit??'',J:''}))sheet.set(col+row,value);
  });
  const stock=syncLedger(book,{throughDate,openingBalances});const packed=book.pack(),reopened=new Workbook(packed);verifyLedger(reopened,{throughDate});
  // The original history and both sales sheets must survive migration byte for byte.
  for(const name of [SHEETS.stock,SHEETS.gurgaon,SHEETS.gujarat]){const file=book.sheet(name).file;if(!Buffer.from(reopened.files[file]).equals(Buffer.from(scratch.files[file])))throw Error('Migration unexpectedly changed source sheet '+name);}
  const focusRow=Math.max(2,...[...reopened.sheet(LEDGER).rows.keys()].filter(row=>reopened.sheet(LEDGER).value('A'+row)===throughDate));reopened.focus(LEDGER,focusRow);
  const output=reopened.pack();verifyLedger(new Workbook(output),{throughDate});
  return {bytes:output,report:{format:'ledger-v1',fromDate,throughDate,originalSha256:hash(bytes),openingBalances:seeds.map(s=>({...s,quantity:qty(s.quantity)})),importedManualRows:movements.length,excludedLegacyDateRows,recoveries,warnings,stock}};
}
function main(){
  const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){if(!args[i+1]||!['--input','--output','--from','--date'].includes(args[i]))throw Error('Usage: npm run norma:migrate -- --input PATH --output NEW_PATH --from YYYY-MM-DD [--date YYYY-MM-DD]');options[args[i].slice(2)]=args[i+1];}
  if(!options.input||!options.output)throw Error('Specify --input and a new --output XLSX path');
  const input=path.resolve(options.input),output=path.resolve(options.output);if(input.toLowerCase()===output.toLowerCase()||path.extname(output).toLowerCase()!=='.xlsx')throw Error('Output must be a separate .xlsx file');
  if(fs.existsSync(output)||fs.existsSync(output+'.migration.json'))throw Error('Output already exists; choose a new filename');
  if(fs.existsSync(path.join(path.dirname(input),'~$'+path.basename(input)))||fs.existsSync(input+'.norma.lock'))throw Error('Close Excel and stop the Norma parser before migration');
  const original=fs.readFileSync(input),result=migrateWorkbook(original,{fromDate:options.from,throughDate:options.date||today()});
  if(hash(fs.readFileSync(input))!==hash(original))throw Error('Source workbook changed during migration; retry after closing Excel');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,result.bytes,{flag:'wx'});fs.writeFileSync(output+'.migration.json',JSON.stringify({...result.report,input,output},null,2),{flag:'wx'});
  console.log('Migrated workbook:',output);console.log('Verified stock rows:',result.report.stock.reconciliation.rows);console.log('Original workbook unchanged. Set workbookPath in norma/config.json to the migrated workbook.');
  for(const warning of result.report.warnings)console.log('Migration review:',warning);
}
if(require.main===module)try{main();}catch(error){console.error('Norma migration:',error.message);process.exitCode=1;}
module.exports={migrateWorkbook};
