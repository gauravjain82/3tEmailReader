// Stable stock keys and numeric balances: no dependency on row positions or Excel calculation.
const {decimal}=require('../pdf/decimal');
const crypto=require('crypto');
const {validDate}=require('../pdf/validators/invoiceValidator');
const {SHEETS}=require('./workbook');
const LEDGER='STOCK LEDGER',OPENINGS='STOCK OPENINGS';
const LEGACY_SALES='STOCK LEGACY SALES';
const HEADERS=['Date','Location','Part No.','Opening','Received','Transfer out','Dispatch','Closing','Transit','Notes'];
const OPENING_HEADERS=['Effective Date','Location','Part No.','Opening','Source'];
const PART=/^\d{5}M[A-Z0-9]+(?:-[A-Z0-9]+)?$/;
const REGIONS=['gurgaon','gujarat'];
const label=region=>region==='gurgaon'?'Gurgaon':'Gujarat';
const nextDay=date=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const qty=value=>Number(value)/1e6;
function units(value,context){const d=decimal(value===''?'0':value,6);if(d==null)throw Error('Invalid numeric quantity at '+context+': '+value);return BigInt(d.replace('.',''));}
function input(sheet,ref,{blank=true}={}){
  if(sheet.formula(ref)||sheet.cells.get(ref)?.getAttribute('t')==='e')throw Error('Enter a number, not a formula or Excel error, at '+sheet.name+'!'+ref);
  const raw=sheet.value(ref);if(!blank&&raw==='')throw Error('Missing number at '+sheet.name+'!'+ref);
  return units(raw,sheet.name+'!'+ref);
}
function parsedDate(book,raw){if(validDate(raw))return raw;const indian=raw.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);if(indian){const date=indian[3]+'-'+indian[2]+'-'+indian[1];return validDate(date)?date:null;}return /^\d+(?:\.0+)?$/.test(raw)?book.date(raw):null;}
function dateValue(book,sheet,ref){const date=parsedDate(book,sheet.value(ref));if(sheet.formula(ref)||!validDate(date))throw Error('Use an ISO date (YYYY-MM-DD) or Excel date at '+sheet.name+'!'+ref);return date;}
function regionValue(sheet,ref){const value=sheet.value(ref).trim().toLowerCase();if(sheet.formula(ref)||!REGIONS.includes(value))throw Error('Location must be Gurgaon or Gujarat at '+sheet.name+'!'+ref);return value;}
function partValue(sheet,ref){const value=sheet.value(ref).trim();if(sheet.formula(ref)||!PART.test(value))throw Error('Invalid part at '+sheet.name+'!'+ref);return value;}
function checkHeaders(sheet,headers){headers.forEach((header,index)=>{if(sheet.value(String.fromCharCode(65+index)+'1').trim().toLowerCase()!==header.toLowerCase())throw Error('Unexpected '+sheet.name+' header in column '+String.fromCharCode(65+index)+': expected '+header);});}
function hasLedger(book){return book.sheets.has(LEDGER)||book.sheets.has(OPENINGS);}
function readInputs(book){
  const sheet=book.sheet(LEDGER),openingSheet=book.sheet(OPENINGS);checkHeaders(sheet,HEADERS);checkHeaders(openingSheet,OPENING_HEADERS);
  const seeds=new Map(),baseline={};
  for(const row of openingSheet.rows.keys()){
    if(row<2||!OPENING_HEADERS.some((_,i)=>openingSheet.value(String.fromCharCode(65+i)+row)!==''||openingSheet.formula(String.fromCharCode(65+i)+row)))continue;
    const date=dateValue(book,openingSheet,'A'+row),region=regionValue(openingSheet,'B'+row),part=partValue(openingSheet,'C'+row),key=region+':'+part;
    if(seeds.has(key))throw Error('Duplicate stock opening for '+key+'; keep one opening per location and part');
    seeds.set(key,{date,region,part,quantity:input(openingSheet,'D'+row,{blank:false}),row});baseline[region]=!baseline[region]||date<baseline[region]?date:baseline[region];
  }
  if(!seeds.size)throw Error('STOCK OPENINGS needs verified starting balances before stock can be calculated');
  const rows=new Map();
  for(const row of sheet.rows.keys()){
    if(row<2||!HEADERS.some((_,i)=>sheet.value(String.fromCharCode(65+i)+row)!==''||sheet.formula(String.fromCharCode(65+i)+row)))continue;
    const date=dateValue(book,sheet,'A'+row),region=regionValue(sheet,'B'+row),part=partValue(sheet,'C'+row),key=date+':'+region+':'+part;
    if(rows.has(key))throw Error('Duplicate stock ledger key '+key+'; combine its manual movements into one row');
    const manual={};for(const [field,col] of [['received','E'],['transfer','F'],['transit','I']])manual[field]={value:input(sheet,col+row),raw:sheet.value(col+row)};
    if(region==='gujarat'&&manual.transfer.value!==0n)throw Error('Transfer out applies to Gurgaon only at '+LEDGER+'!F'+row);
    if(sheet.formula('J'+row))throw Error('Notes must be text at '+LEDGER+'!J'+row);
    rows.set(key,{date,region,part,row,manual,notes:sheet.value('J'+row)});
  }
  return {sheet,openingSheet,seeds,baseline,rows};
}
function salesTotals(book,{fromDate,baseline}={}){
  baseline=baseline||(book.sheets.has(OPENINGS)?readInputs(book).baseline:{});
  const totals=new Map(),exclusions=new Set();let excluded=0;
  if(book.sheets.has(LEGACY_SALES)){const history=book.sheet(LEGACY_SALES);checkHeaders(history,['Location','Invoice','Part No.','Original Date','Row Fingerprint','Reason']);for(const row of history.rows.keys())if(row>1&&history.value('E'+row))exclusions.add(history.value('E'+row));}
  // Read independently of the old salesRows filter: a malformed part/date must
  // not silently disappear from stock just because that filter skipped a row.
  for(const region of REGIONS){const sheet=book.sheet(SHEETS[region]);for(const row of sheet.rows.keys()){
    if(row<2)continue;const number=sheet.value('B'+row);if(!number)continue;
    if(exclusions.has(salesFingerprint(sheet,row,region))){excluded++;continue;}
    const savedDate=parsedDate(book,sheet.value('C'+row)),boundary=fromDate||baseline[region];
    // The explicit verified opening already includes history before cutover.
    // Legacy part/quantity mistakes there cannot alter this ledger's balances.
    if(validDate(savedDate)&&boundary&&savedDate<boundary)continue;
    if(!/^\d{8,14}$/.test(number))throw Error('Invalid invoice number at '+sheet.name+'!B'+row);
    const part=partValue(sheet,'D'+row),date=dateValue(book,sheet,'C'+row),quantity=input(sheet,'E'+row,{blank:false});
    if(quantity<0n)throw Error('Negative invoice quantity at '+sheet.name+'!E'+row);
    const key=date+':'+region+':'+part;totals.set(key,(totals.get(key)||0n)+quantity);
  }}
  if(excluded!==exclusions.size)throw Error('An archived historical sales row changed or was removed; review STOCK LEGACY SALES before proceeding');
  totals.excludedHistoricalSales=excluded;return totals;
}
function salesFingerprint(sheet,row,region){return crypto.createHash('sha256').update(JSON.stringify([region,...'ABCDEFGHIJKL'.split('').map(col=>{const value=sheet.value(col+row);return [/^[+-]?\d+(?:\.\d+)?$/.test(value)?String(Number(value)):value,sheet.formula(col+row)];})])).digest('hex');}
function archiveLegacyDateErrors(book,fromDate){
  const entries=[];
  for(const region of REGIONS){const sheet=book.sheet(SHEETS[region]),rows=[...sheet.rows.keys()].filter(row=>row>1&&sheet.value('B'+row)).sort((a,b)=>a-b);
    for(let index=0;index<rows.length;index++){const row=rows[index];if(validDate(parsedDate(book,sheet.value('C'+row))))continue;
      const previous=rows.slice(0,index).reverse().map(r=>parsedDate(book,sheet.value('C'+r))).find(validDate),following=rows.slice(index+1).map(r=>parsedDate(book,sheet.value('C'+r))).find(validDate);
      if(!previous||!following||previous>=fromDate||following>=fromDate||previous>following)throw Error('Invalid sales date at '+sheet.name+'!C'+row+' cannot be established as history before the cutover; correct it before migration');
      entries.push({region,row,invoice:sheet.value('B'+row),part:sheet.value('D'+row),rawDate:sheet.value('C'+row),fingerprint:salesFingerprint(sheet,row,region),reason:`Undated legacy row between ${previous} and ${following}, both before ledger cutover ${fromDate}; no date inferred`});
    }
  }
  if(entries.length){const sheet=book.addSheet(LEGACY_SALES,{widths:[15,20,22,20,70,100]});['Location','Invoice','Part No.','Original Date','Row Fingerprint','Reason'].forEach((v,i)=>sheet.set(String.fromCharCode(65+i)+'1',v));entries.forEach((entry,i)=>[label(entry.region),entry.invoice,entry.part,entry.rawDate,entry.fingerprint,entry.reason].forEach((value,col)=>sheet.set(String.fromCharCode(65+col)+(i+2),value)));}
  return entries;
}
function planLedger(book,{throughDate,openingBalances={}}){
  if(!validDate(throughDate))throw Error('Invalid Norma stock through-date');
  const state=readInputs(book),totals=salesTotals(book,{baseline:state.baseline}),newParts=[],{seeds,baseline,rows}=state;
  function ensure(region,part,date){
    if(!baseline[region])throw Error('Missing verified opening baseline for '+region);
    const seedKey=region+':'+part;if(!seeds.has(seedKey)&&date>=baseline[region]){const quantity=units(openingBalances[region]?.[part]??0,'new part '+seedKey);seeds.set(seedKey,{date:baseline[region],region,part,quantity});newParts.push(seedKey);}
  }
  // Choose the earliest activity before creating each new part's zero opening.
  const activity=[...[...totals.keys()].map(key=>key.split(':')),...[...rows.values()].map(r=>[r.date,r.region,r.part])].sort((a,b)=>a[0].localeCompare(b[0]));
  for(const [date,region,part] of activity)ensure(region,part,date);
  for(const entry of rows.values()){const seed=seeds.get(entry.region+':'+entry.part);if(!seed||entry.date<seed.date)throw Error('Ledger movement predates its opening for '+entry.region+' '+entry.part+' on '+entry.date);}
  const planned=[],warnings=[];let dispatchTotal=0n;
  for(const seed of seeds.values()){
    let balance=seed.quantity;if(seed.date>throughDate)continue;
    const dayCount=(Date.parse(throughDate)-Date.parse(seed.date))/86400000+1;if(dayCount+planned.length>250000)throw Error('Stock ledger exceeds 250,000 rows; archive it with a verified new opening baseline');
    for(let date=seed.date;date<=throughDate;date=nextDay(date)){
      const key=date+':'+seed.region+':'+seed.part,existing=rows.get(key),received=existing?.manual.received.value||0n,transfer=existing?.manual.transfer.value||0n,dispatch=totals.get(key)||0n,closing=balance+received-transfer-dispatch;
      planned.push({key,date,region:seed.region,part:seed.part,opening:balance,received,transfer,dispatch,closing,existing});
      if(closing<0n)warnings.push(seed.region+' '+date+' '+seed.part+': negative closing stock '+qty(closing));
      balance=closing;dispatchTotal+=dispatch;
    }
  }
  // Explicit openings define the cutover. Old sales are history, not new dispatch.
  for(const [key,value] of totals){const [date,region,part]=key.split(':'),seed=seeds.get(region+':'+part);if(date<=throughDate&&date>=baseline[region]&&(!seed||date<seed.date))throw Error('Sales predate the opening for '+region+' '+part+' on '+date);}
  planned.sort((a,b)=>a.key.localeCompare(b.key));
  return {...state,totals,newParts,planned,warnings,dispatchTotal};
}
function verifyLedger(book,{throughDate}){
  const plan=planLedger(book,{throughDate});
  if(plan.newParts.length)throw Error('Ledger validation found missing part openings');
  for(const item of plan.planned){const row=plan.rows.get(item.key)?.row;if(!row)throw Error('Missing stock ledger entry '+item.key);for(const [col,value] of [['D',item.opening],['G',item.dispatch],['H',item.closing]])if(input(plan.sheet,col+row,{blank:false})!==value)throw Error('Stock reconciliation failed for '+item.key+' column '+col);}
  return {verified:true,rows:plan.planned.length,dispatchQuantity:qty(plan.dispatchTotal),excludedHistoricalSales:plan.totals.excludedHistoricalSales};
}
function styleCell(sheet,ref,style){const cell=sheet.cells.get(ref);if(style&&cell&&cell.getAttribute('s')!==style){cell.setAttribute('s',style);sheet.dirty=true;}}
function initializeSheets(book){
  if(hasLedger(book))throw Error('This workbook already contains ledger sheets');
  const old=book.sheet(SHEETS.stock),headerStyle=old.cells.get('B2')?.getAttribute('s'),bodyStyle=old.cells.get('B3')?.getAttribute('s');
  for(const [name,headers,widths] of [[LEDGER,HEADERS,[15,15,22,16,16,18,16,16,16,50]],[OPENINGS,OPENING_HEADERS,[18,15,22,16,85]]]){
    const sheet=book.addSheet(name,{widths});headers.forEach((header,i)=>{const ref=String.fromCharCode(65+i)+'1';sheet.set(ref,header);styleCell(sheet,ref,headerStyle);});sheet.bodyStyle=bodyStyle;
  }
}
function syncLedger(book,options){
  const plan=planLedger(book,options),{sheet,openingSheet}=plan,changed=[];
  for(const key of plan.newParts){const seed=plan.seeds.get(key),row=openingSheet.maxRow()+1;[seed.date,label(seed.region),seed.part,qty(seed.quantity),'New part: initial opening '+qty(seed.quantity)].forEach((v,i)=>openingSheet.set(String.fromCharCode(65+i)+row,v));}
  // Keep existing physical rows and manual fields intact, so sorting the sheet
  // or inserting rows has no effect on the identity of a movement.
  for(const item of plan.planned){const row=item.existing?.row||sheet.maxRow()+1;
    const before={opening:sheet.value('D'+row),dispatch:sheet.value('G'+row),closing:sheet.value('H'+row)};
    const values={A:item.date,B:label(item.region),C:item.part,D:qty(item.opening),G:qty(item.dispatch),H:qty(item.closing)};
    for(const [col,value] of Object.entries(values))sheet.set(col+row,value);
    if(!item.existing)for(const col of ['E','F','I','J'])sheet.set(col+row,'');
    const old=book.sheet(SHEETS.stock),bodyStyle=old.cells.get('B3')?.getAttribute('s');for(const col of 'ABCDEFGHIJ'){if(!sheet.cells.has(col+row))sheet.copyStyle(col+row,'B'+row);styleCell(sheet,col+row,bodyStyle);}
    if(before.opening!==String(qty(item.opening))||before.dispatch!==String(qty(item.dispatch))||before.closing!==String(qty(item.closing)))changed.push({date:item.date,region:item.region,partNumber:item.part,row,previous:before,opening:qty(item.opening),dispatch:qty(item.dispatch),closing:qty(item.closing)});
  }
  const reconciliation=verifyLedger(book,options);
  return {format:'ledger-v1',createdDays:0,updatedDays:new Set(plan.planned.map(p=>p.date)).size,openingSources:[...plan.seeds.values()].map(s=>({region:s.region,partNumber:s.part,sourceDate:s.date,sourceCell:s.row?'STOCK OPENINGS!D'+s.row:null,quantity:qty(s.quantity)})),recoveries:[],newParts:plan.newParts,changes:changed,warnings:plan.warnings,reconciliation};
}
function checkInvoiceWindow(book,invoice){
  if(!hasLedger(book))return;const {seeds,baseline}=readInputs(book);
  for(const item of invoice.items){const first=seeds.get(invoice.region+':'+item.partNumber)?.date||baseline[invoice.region];if(!first||invoice.date<first)throw Error('Invoice '+invoice.invoiceNumber+' predates the verified ledger opening '+(first||'for '+invoice.region)+'. Migrate from an earlier date before adding this historical invoice.');}
}
module.exports={LEDGER,OPENINGS,LEGACY_SALES,HEADERS,OPENING_HEADERS,hasLedger,initializeSheets,syncLedger,verifyLedger,readInputs,salesTotals,units,qty,label,nextDay,checkInvoiceWindow,archiveLegacyDateErrors};
