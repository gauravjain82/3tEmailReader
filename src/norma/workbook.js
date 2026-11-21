const {decimal,minor}=require('../pdf/decimal');
const {validDate}=require('../pdf/validators/invoiceValidator');
const SHEETS={gujarat:'Norma sales report Smg',gurgaon:'Norma sales report Ggn.',stock:'STOCK DETAILS'};
const partPattern=/^\d{5}M[A-Z0-9]+(?:-[A-Z0-9]+)?$/;
const units=value=>{const d=decimal(value===''||value==null?'0':value,6);if(d==null)throw Error('Invalid stock quantity: '+value);return BigInt(d.replace('.',''));};
const quantity=value=>Number(value)/1e6;
const legacyMoney=value=>{const direct=decimal(value);if(direct!=null)return minor(direct);const n=Number(value);if(value===''||!Number.isFinite(n))throw Error('Missing/invalid amount in an existing Norma sales row');return minor(n.toFixed(2));};
const plantKey=value=>String(value).toUpperCase().replace(/\s/g,'').replace(/^GGNSPD$/,'MSILGSPD').replace(/OESS$/,'OES');
function salesRows(book,region){const sheet=book.sheet(SHEETS[region]),rows=[];for(const row of sheet.rows.keys()){if(row<2)continue;const number=sheet.value('B'+row),part=sheet.value('D'+row);if(/^\d{8,14}$/.test(number)&&partPattern.test(part))rows.push({row,number,part,date:book.date(sheet.value('C'+row)),qty:sheet.value('E'+row),plant:sheet.value('F'+row),price:sheet.value('G'+row),taxable:sheet.value('I'+row),cgst:region==='gurgaon'?sheet.value('J'+row):'0',sgst:region==='gurgaon'?sheet.value('K'+row):'0',igst:region==='gujarat'?sheet.value('J'+row):'0',total:sheet.value((region==='gurgaon'?'L':'K')+row)});}return rows;}
function checkHeaders(book){for(const region of ['gurgaon','gujarat']){const s=book.sheet(SHEETS[region]);const expected=['S.NO','INVOICE NO.','BILL DATE','PART NUMBER','QUANTITY','PLANT','BASIC RATE','SRV NO.','ASSESSABLE VALUE',region==='gurgaon'?'CGST':'IGST',region==='gurgaon'?'SGST':'GRAND TOTAL',region==='gurgaon'?'GRAND TOTAL':'REMARKS'];expected.forEach((value,i)=>{if(s.value(String.fromCharCode(65+i)+'1').replace(/\s+/g,' ').trim().toUpperCase()!==value)throw Error('Unexpected '+SHEETS[region]+' header in column '+String.fromCharCode(65+i));});}book.sheet(SHEETS.stock);}
function addInvoice(book,invoice){
  const rows=salesRows(book,invoice.region).filter(r=>r.number===invoice.invoiceNumber),other=invoice.region==='gujarat'?'gurgaon':'gujarat';
  if(salesRows(book,other).some(r=>r.number===invoice.invoiceNumber))throw Error('Invoice already exists in the other region sheet: '+invoice.invoiceNumber);
  if(rows.length){
    const expected=new Map(),actual=new Map(),fields=['taxable','cgst','sgst','igst','total'];
    function group(map,part,qty,price,values,readMoney){const g=map.get(part)||{qty:0n,prices:new Set(),...Object.fromEntries(fields.map(f=>[f,0n]))};g.qty+=units(qty);const rate=decimal(price,6);if(rate==null)throw Error('Invalid existing Norma basic rate');g.prices.add(rate);for(const field of fields)g[field]+=readMoney(values[field]);map.set(part,g);}
    for(const i of invoice.items)group(expected,i.partNumber,i.quantity,i.unitPrice,i,minor);
    for(const r of rows){if(r.date!==invoice.date||plantKey(r.plant)!==plantKey(invoice.plant))throw Error('Existing invoice date/plant conflicts: '+invoice.invoiceNumber);group(actual,r.part,r.qty,r.price,r,legacyMoney);}
    const near=(a,b)=>a-b>=-2n&&a-b<=2n;
    if(expected.size!==actual.size||[...expected].some(([p,e])=>{const a=actual.get(p);return !a||e.qty!==a.qty||[...e.prices].sort().join()!==[...a.prices].sort().join()||fields.some(f=>!near(e[f],a[f]));}))throw Error('Existing invoice parts/quantities/amounts conflict: '+invoice.invoiceNumber);
    return {invoiceNumber:invoice.invoiceNumber,status:'ALREADY_PRESENT',rows:rows.map(r=>r.row)};
  }
  const sheet=book.sheet(SHEETS[invoice.region]),existing=salesRows(book,invoice.region);let row=Math.max(1,...existing.map(r=>r.row))+1;
  let serial=Math.max(0,...existing.map(r=>Number(sheet.value('A'+r.row))||0));const template=Math.max(2,row-1),added=[];
  for(const item of invoice.items){const values=[++serial,invoice.invoiceNumber,book.serial(invoice.date),item.partNumber,Number(item.quantity),invoice.plant,Number(item.unitPrice),'',Number(item.taxable),Number(invoice.region==='gujarat'?item.igst:item.cgst),Number(invoice.region==='gujarat'?item.total:item.sgst),invoice.region==='gujarat'?'':Number(item.total)];values.forEach((value,i)=>sheet.set(String.fromCharCode(65+i)+row,value,{styleFrom:String.fromCharCode(65+i)+template}));added.push(row++);}
  return {invoiceNumber:invoice.invoiceNumber,status:'ADDED',rows:added};
}

function stockBlocks(sheet,region){
  const names=region==='gurgaon'?['A','B']:['I','J'],label=region==='gurgaon'?'Gurgaon':'Gujarat',titles=[];
  for(const row of sheet.rows.keys())for(const col of names){const m=sheet.value(col+row).match(new RegExp('Norma\\s+'+label+'\\s*(\\d{2})[./-](\\d{2})[./-](\\d{4})','i'));if(m){const date=`${m[3]}-${m[2]}-${m[1]}`;if(!validDate(date))throw Error('Invalid stock heading date at '+col+row);titles.push({date,title:row,parts:new Map()});}}
  titles.sort((a,b)=>a.title-b.title);const partCol=region==='gurgaon'?'B':'J';
  titles.forEach((block,i)=>{block.end=(titles[i+1]?.title||sheet.maxRow()+3)-1;for(let row=block.title+2;row<=Math.min(block.end,sheet.maxRow());row++){const part=sheet.value(partCol+row);if(partPattern.test(part))block.parts.set(part,row);}});
  return titles;
}

function latestClosing(sheet,blocks,{region,part,beforeDate,recovery}){
  // Match worksheet entries by region, part and date. Row position only breaks
  // ties between repeated headings: the last entry for that date wins.
  const entries=blocks.filter(b=>b.date<beforeDate&&b.parts.has(part)).sort((a,b)=>b.date.localeCompare(a.date)||b.title-a.title);
  if(!entries.length)return null;
  const block=entries[0],row=block.parts.get(part),ref=(region==='gurgaon'?'G':'N')+row;
  const raw=sheet.value(ref),formula=sheet.formula(ref),error=sheet.cells.get(ref)?.getAttribute('t')==='e';
  const parsed=decimal(raw,6);
  if(raw===''||error||parsed==null||/#(?:REF!|VALUE!|DIV\/0!|N\/A|NAME\?|NUM!|NULL!)/i.test(formula)){
    const restored=recovery&&recoverClosing(sheet,entries,{region,part,recovery});
    if(restored!=null)return {region,partNumber:part,date:beforeDate,sourceDate:block.date,sourceRow:row,sourceCell:ref,quantity:restored,recovered:true};
    throw Error('Latest stock entry for '+region+' '+part+' on '+block.date+' has no valid saved closing quantity at STOCK DETAILS!'+ref+'. Correct that latest entry in Excel, recalculate, save and close Excel, then retry. An older entry or zero will not be substituted.');
  }
  return {region,partNumber:part,date:beforeDate,sourceDate:block.date,sourceRow:row,sourceCell:ref,quantity:BigInt(parsed.replace('.',''))};
}

function recoverClosing(sheet,entries,{region,part,recovery}){
  const c=region==='gurgaon'?{opening:'C',received:'D',transfer:'E',dispatch:'F',balance:'G'}:{opening:'K',received:'L',dispatch:'M',balance:'N'};
  const latest=entries[0],lastRow=latest.parts.get(part),broken=ref=>/^\+?#REF!$/i.test((sheet.formula(ref)||sheet.value(ref)).replace(/^=/,'').trim());
  // Recover this specific defect, not arbitrary missing/corrupt balances.
  if(!broken(c.opening+lastRow)||!/#REF!/i.test(sheet.value(c.balance+lastRow)+' '+sheet.formula(c.balance+lastRow)))return null;
  const days=new Map();for(const entry of entries)if(!days.has(entry.date))days.set(entry.date,entry);
  const ordered=[...days.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const validClosing=entry=>{const ref=c.balance+entry.parts.get(part);return decimal(sheet.value(ref),6)!=null&&sheet.cells.get(ref)?.getAttribute('t')!=='e'&&!/#/.test(sheet.formula(ref));};
  const base=[...ordered].reverse().find(e=>e.date<latest.date&&validClosing(e));
  let balance,first,basis;
  if(base){balance=units(sheet.value(c.balance+base.parts.get(part)));first=nextDay(base.date);basis='previous-valid-closing';}
  else {const earliest=ordered[0],ref=c.opening+earliest.parts.get(part),value=decimal(sheet.value(ref),6);if(value!=null&&sheet.cells.get(ref)?.getAttribute('t')!=='e'&&!/#/.test(sheet.formula(ref))){balance=units(value);basis='recorded-initial-opening';}else if(broken(ref)){const configured=Object.hasOwn(recovery.openingBalances[region]||{},part);if(!configured&&[...recovery.totals].some(([key,value])=>key.endsWith(':'+part)&&key.slice(0,10)<earliest.date&&value!==0n))return null;balance=units(recovery.openingBalances[region]?.[part]??0);basis=configured?'configured-new-part-opening':'new-part-zero-opening';}else return null;first=earliest.date;}
  if((Date.parse(latest.date)-Date.parse(first))/86400000>370)throw Error('Stock recovery exceeds 370 days for '+part+'; verify the latest closing in Excel');
  const plans=[],steps=[];
  for(let date=first;date<=latest.date;date=nextDay(date)){
    const entry=days.get(date),row=entry?.parts.get(part),salesKnown=recovery.totals.has(date+':'+part);let received=0n,transfer=0n,dispatch=recovery.totals.get(date+':'+part)||0n;
    if(row){
      const openingRef=c.opening+row,openingFormula=sheet.formula(openingRef).replace(/[$\s=]/g,''),closingRef=c.balance+row,closingFormula=sheet.formula(closingRef).replace(/[$\s=]/g,'');
      const expected=openingRef+'+'+c.received+row+(c.transfer?'-'+c.transfer+row:'')+'-'+c.dispatch+row;
      if(closingFormula!==expected&&!broken(closingRef))return null;
      if(!broken(openingRef)&&!new RegExp('^'+c.balance+'\\d+$').test(openingFormula)){
        if(!openingFormula&&decimal(sheet.value(openingRef),6)!=null)balance=units(sheet.value(openingRef));else return null;
      }
      const calc=stockCalculator(sheet);received=calc(c.received+row);transfer=c.transfer?calc(c.transfer+row):0n;
      if(!salesKnown&&(sheet.value(c.dispatch+row)!==''||sheet.formula(c.dispatch+row)))dispatch=calc(c.dispatch+row);
      plans.push({openingRef,closingRef,opening:balance,formula:expected,oldOpening:sheet.formula(openingRef)||sheet.value(openingRef),oldClosing:sheet.value(closingRef),dispatchRef:c.dispatch+row,oldDispatch:sheet.value(c.dispatch+row),dispatch,salesKnown});
    }
    const opening=balance;balance+=received-transfer-dispatch;
    if(row)plans.at(-1).closing=balance;
    steps.push({date,row:row??null,opening:quantity(opening),received:quantity(received),transfer:quantity(transfer),dispatch:quantity(dispatch),closing:quantity(balance),dispatchSource:!salesKnown&&row&&(sheet.value(c.dispatch+row)!==''||sheet.formula(c.dispatch+row))?'stock-entry':'sales-sheet'});
  }
  for(const plan of plans){sheet.number(plan.openingRef,quantity(plan.opening));if(plan.salesKnown)sheet.number(plan.dispatchRef,quantity(plan.dispatch));sheet.number(plan.closingRef,quantity(plan.closing),{formula:plan.formula});}
  recovery.recoveries.push({region,partNumber:part,date:latest.date,basis,baseDate:base?.date||null,baseCell:base?c.balance+base.parts.get(part):null,quantity:quantity(balance),steps,changes:plans.map(p=>({openingCell:p.openingRef,previousOpening:p.oldOpening,newOpening:quantity(p.opening),closingCell:p.closingRef,previousClosing:p.oldClosing,newClosing:quantity(p.closing)}))});
  return balance;
}

function stockCalculator(sheet){
  const cache=new Map(),active=new Set();
  function cell(ref){
    ref=ref.replace(/\$/g,'');if(cache.has(ref))return cache.get(ref);if(active.has(ref))throw Error('Circular stock formula: '+ref);active.add(ref);
    try {
      const formula=sheet.formula(ref),raw=sheet.value(ref);let value;
      if(/#REF!/i.test(formula)||raw==='#REF!')throw Error('Broken stock formula at STOCK DETAILS!'+ref+'. Correct this current-day value/formula in Excel, save and close Excel, then retry.');
      if(!formula)value=units(raw);
      else {
        const text=formula.replace(/^=/,'').replace(/\s/g,'');const tokens=text.match(/\$?[A-Z]+\$?\d+|\d+(?:\.\d+)?|[()+-]/g)||[];
        if(tokens.join('')!==text)throw Error('Unsupported stock formula at '+ref+': '+formula);let at=0;
        function atom(){const t=tokens[at++];if(t==='+')return atom();if(t==='-')return -atom();if(t==='('){const n=expression();if(tokens[at++]!==')')throw Error('Unbalanced stock formula '+ref);return n;}if(/^\$?[A-Z]/.test(t||''))return cell(t);if(/^\d/.test(t||''))return units(t);throw Error('Invalid stock formula '+ref);}
        function expression(){let n=atom();while(tokens[at]==='+'||tokens[at]==='-'){const op=tokens[at++],right=atom();n=op==='+'?n+right:n-right;}return n;}
        value=expression();if(at!==tokens.length)throw Error('Invalid stock formula '+ref);
      }
      cache.set(ref,value);return value;
    } finally {active.delete(ref);}
  }return cell;
}
const nextDay=date=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
function syncStock(book,{affected={gurgaon:[],gujarat:[]},throughDate,extraParts=[],openingBalances={}}){
  if(book.sheets.has('STOCK LEDGER')||book.sheets.has('STOCK OPENINGS'))return require('./ledger').syncLedger(book,{throughDate,openingBalances});
  if(!validDate(throughDate))throw Error('Invalid Norma stock through-date');const sheet=book.sheet(SHEETS.stock),result={createdDays:0,updatedDays:0,warnings:[],openingSources:[],recoveries:[]};const newTitles=new Map(),updatedDates=new Set();
  // Reserve enough vertical space for either side before arranging new days.
  const possibleParts=new Set(extraParts);for(const [ref] of sheet.cells)if(/^(?:B|J)\d+$/.test(ref)&&partPattern.test(sheet.value(ref)))possibleParts.add(sheet.value(ref));for(const region of ['gurgaon','gujarat'])for(const row of salesRows(book,region))possibleParts.add(row.part);
  const blockHeight=possibleParts.size+4;let nextTitle=sheet.maxRow()+2;
  for(const region of ['gurgaon','gujarat']){
    const cols=region==='gurgaon'?{serial:'A',part:'B',opening:'C',received:'D',transfer:'E',dispatch:'F',balance:'G'}:{serial:'I',part:'J',opening:'K',received:'L',dispatch:'M',balance:'N'};
    const blocks=stockBlocks(sheet,region),latest=blocks.map(b=>b.date).sort().at(-1),dates=affected[region]||[];
    const start=[latest?nextDay(latest):throughDate,throughDate,...dates].sort()[0];if(start>throughDate)continue;
    if((Date.parse(throughDate)-Date.parse(start))/86400000>370)throw Error('More than 370 daily stock blocks requested; choose a recent opening workbook');
    const totals=new Map(),sales=salesRows(book,region);for(const row of sales){const key=row.date+':'+row.part;totals.set(key,(totals.get(key)||0n)+units(row.qty));}
    for(let date=start;date<=throughDate;date=nextDay(date)){
      const matches=blocks.filter(b=>b.date===date);
      let block=matches.at(-1),fresh=!block;
      if(fresh){let title=newTitles.get(date);if(!title){title=nextTitle;nextTitle+=blockHeight;newTitles.set(date,title);}const day=date.split('-').reverse().join('.');sheet.set(cols.part+title,`Norma ${region==='gurgaon'?'Gurgaon':'Gujarat'} ${day} opening`);const headings={[cols.serial]:'SR. No.',[cols.part]:'Part No.',[cols.opening]:'Opening Qty.',[cols.received]:'received quantity',...(cols.transfer?{[cols.transfer]:'GGN to SMG'}:{}),[cols.dispatch]:region==='gurgaon'?'MSIL Despatch qty.':'Despatch qty.',[cols.balance]:'Balance',...(region==='gujarat'?{O:'Transit'}:{})};for(const [c,v] of Object.entries(headings))sheet.set(c+(title+1),v,{styleFrom:c+'2'});block={date,title,end:Infinity,parts:new Map()};blocks.push(block);result.createdDays++;}
      const earlier=blocks.filter(b=>b.date<date).sort((a,b)=>b.date.localeCompare(a.date)||b.title-a.title);
      const parts=new Set([...earlier.flatMap(b=>[...b.parts.keys()]),...block.parts.keys(),...extraParts,...sales.filter(r=>r.date===date).map(r=>r.part)]);
      for(const part of parts){if(!partPattern.test(part))throw Error('Invalid Norma stock part '+part);let row=block.parts.get(part);if(!row){row=Math.max(block.title+2,...[...block.parts.values()].map(r=>r+1));if(!fresh){while(row<=block.end&&[cols.part,cols.opening,cols.received,cols.transfer,cols.dispatch,cols.balance].filter(Boolean).some(c=>sheet.value(c+row)!==''||sheet.formula(c+row)))row++;if(row>block.end)throw Error('No free stock row for '+part+' on '+date+'; add a blank row to that stock block in Excel');}sheet.set(cols.part+row,part,{styleFrom:cols.part+'3'});sheet.set(cols.serial+row,block.parts.size+1,{styleFrom:cols.serial+'3'});block.parts.set(part,row);}
        const source=latestClosing(sheet,blocks,{region,part,beforeDate:date,recovery:{totals,openingBalances,recoveries:result.recoveries}}),openingRef=cols.opening+row;
        if(source){sheet.number(openingRef,quantity(source.quantity),{styleFrom:cols.opening+'3'});result.openingSources.push({...source,quantity:quantity(source.quantity)});}
        else if(sheet.value(openingRef)===''&&!sheet.formula(openingRef))sheet.number(openingRef,openingBalances[region]?.[part]??0,{styleFrom:cols.opening+'3'});
        sheet.number(cols.dispatch+row,quantity(totals.get(date+':'+part)||0n),{styleFrom:cols.dispatch+'3'});
        const formula=openingRef+'+'+cols.received+row+(cols.transfer?'-'+cols.transfer+row:'')+'-'+cols.dispatch+row;
        const calc=stockCalculator(sheet),balance=calc(openingRef)+calc(cols.received+row)-(cols.transfer?calc(cols.transfer+row):0n)-calc(cols.dispatch+row);
        sheet.number(cols.balance+row,quantity(balance),{formula,styleFrom:cols.balance+'3'});
        if(balance<0n)result.warnings.push(`${region} ${date} ${part}: negative closing stock ${quantity(balance)}`);
      }
      result.updatedDays++;
      updatedDates.add(date);
    }
  }
  // Format complete rectangles, including empty manual-entry cells. Copying
  // only populated cells leaves broken borders and an unbordered Transit column.
  const layouts={gurgaon:{start:65,end:71,part:'B'},gujarat:{start:73,end:79,part:'J'}};
  const blocksByRegion=Object.fromEntries(['gurgaon','gujarat'].map(region=>[region,stockBlocks(sheet,region)]));
  for(const date of updatedDates){
    const left=blocksByRegion.gurgaon.filter(b=>b.date===date).at(-1),right=blocksByRegion.gujarat.filter(b=>b.date===date).at(-1);
    const aligned=left&&right&&left.title===right.title;
    const alignedEnd=aligned?Math.max(left.title+2,...left.parts.values(),...right.parts.values()):null;
    for(const region of ['gurgaon','gujarat']){
      const block=blocksByRegion[region].filter(b=>b.date===date).at(-1);if(!block)continue;
      const layout=layouts[region],last=alignedEnd??Math.max(block.title+2,...block.parts.values());
      for(let code=layout.start;code<=layout.end;code++){
        const col=String.fromCharCode(code),template=col==='O'?'N':col;
        sheet.copyStyle(col+(block.title+1),template+'2',layout.part+'2');
        for(let row=block.title+2;row<=last;row++)sheet.copyStyle(col+row,template+'3',layout.part+'3');
      }
    }
  }
  return result;
}
module.exports={SHEETS,checkHeaders,addInvoice,syncStock,salesRows,stockBlocks,stockCalculator,latestClosing};
