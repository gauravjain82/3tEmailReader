const fs=require('fs');
const {minor,productMinor}=require('../pdf/decimal');
const {extractItemName,partNameForItem,plantForLocation}=require('./mappings');
const COLUMNS=['Invoice Number','Invoice Date','PART NAME','Item Name','Qty','Ack. No','Ack Date','Location(Plant)','Cust. Code','Basic value','Packing charges','CGST Amt.','SGST Amt.','Total Value'];
const numeric=text=>text.replace(/[Oo]/g,'0').replace(/[Il|]/g,'1').replace(/\//g,'7');
function groups(items,tolerance=.004){
  const result=[];
  for(const item of [...items].sort((a,b)=>a.y-b.y||a.x-b.x)){
    let group=result.find(g=>Math.abs(g.y-item.y)<tolerance);
    if(!group){group={y:item.y,items:[]};result.push(group);}group.items.push(item);
  }
  return result.map(g=>({...g,text:g.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join(' ')}));
}
function money(text){
  const s=numeric(text).replace(/,/g,'').trim();
  if(/^\d+\.\s*\d{2}$/.test(s))return s.replace(/\s/g,'');
  if(/^\d+\s+\d{2}$/.test(s))return s.replace(/\s+/,'.');
  return null;
}
function numbers(items){
  return items.flatMap(i=>{
    if(!/^[\dOoIl|.,()@%/\s+*-]+$/.test(i.text.trim()))return [];
    const value=numeric(i.text.replace(/^\|(?=\d)/,'')),result=[];
    for(const m of value.matchAll(/\d+\.\s*\d{2}|\d+/g))result.push({...i,text:m[0],x:i.x+i.w*m.index/Math.max(1,value.length)});
    return result;
  });
}
function date(text){
  const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const m=text.match(/(?<!\d)(\d{1,2})\s*[-.]?\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*[-.]?\s*(20\d{2})(?!\d)/i);
  if(!m)return '';
  const day=m[1].padStart(2,'0'),month=String(months.indexOf(m[2].toLowerCase())+1).padStart(2,'0');
  const iso=`${m[3]}-${month}-${day}`,d=new Date(iso+'T00:00:00Z');
  return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===iso?`${day}.${month}.${m[3]}`:'';
}
function validAckDate(value){
  const m=String(value||'').match(/^(\d{2})\.(\d{2})\.(20\d{2})$/);
  if(!m)return false;const iso=`${m[3]}-${m[2]}-${m[1]}`,d=new Date(iso+'T00:00:00Z');
  return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===iso;
}
function parseAcknowledgement(text,invoiceDate=''){
  const lines=String(text||'').split(/[\r\n]+/).map(s=>s.trim()).filter(Boolean);
  const candidates=[...new Set(lines.flatMap(line=>{
    const compact=line.replace(/\s/g,'');return /^\d{10}$/.test(compact)?[compact]:[];
  }))];
  const dates=[];
  for(const m of String(text||'').matchAll(/(?<!\d)(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(20\d{2}|\d{2})(?!\d)/g)){
    const year=m[3].length===4?m[3]:(invoiceDate.slice(-4).match(/^20\d{2}$/)?invoiceDate.slice(-4,-2)+m[3]:'');
    const value=`${m[1].padStart(2,'0')}.${m[2].padStart(2,'0')}.${year}`;
    if(validAckDate(value))dates.push(value);
  }
  const uniqueDates=[...new Set(dates)];
  return {number:candidates.length===1?candidates[0]:'',date:uniqueDates.length===1?uniqueDates[0]:''};
}
function parsePage(page){
  const items=page.items.filter(i=>i.text.trim()),all=items.map(i=>i.text).join(' ');
  const issues=[],notes=[];const issue=message=>issues.push(message);
  if(!/Against\s+R[eo]j[eo]ction/i.test(all))throw Error('Unsupported page: rejection-invoice heading not found.');
  const invoice=items.find(i=>/^HG[0-9OIl|]{10}$/i.test(i.text.trim()));
  if(!invoice)throw Error('Invoice number not readable.');
  const invoiceNumber='HG'+numeric(invoice.text.trim().slice(2));
  if(invoiceNumber!==invoice.text.trim())notes.push('Invoice-number OCR character corrected in numeric suffix.');
  const header=items.filter(i=>i.x>.3&&i.y>.2&&i.y<.36).sort((a,b)=>a.y-b.y||a.x-b.x);
  const invoiceDate=date(header.map(i=>i.text).join(' '));
  if(!invoiceDate)issue('Invoice date missing or invalid.');
  const billTo=items.find(i=>/^Bill\s*(?:to:?)*$/i.test(i.text)&&i.y>.29&&i.y<.4&&i.x<.5);
  const customerLine=billTo?items.filter(i=>Math.abs(i.y-billTo.y)<.004&&i.x>=billTo.x&&i.x<.55).sort((a,b)=>a.x-b.x).map(i=>i.text).join(' '):'';
  const customerCode=customerLine.match(/\bto\s*:\s*([A-Z]\d{3,})\b/i)?.[1]||'';
  const postcode=items.find(i=>/^\d{6}$/.test(i.text)&&i.y<invoice.y-.006&&i.y>invoice.y-.065&&i.x>.25&&i.x<.6);
  const location=postcode?items.filter(i=>Math.abs(i.y-postcode.y)<.004&&i.x>.2&&i.x<=postcode.x).sort((a,b)=>a.x-b.x).map(i=>i.text).join(' '):'';
  const plant=plantForLocation(location);
  notes.push('Item Name and supplier city are read from the PDF. PART NAME, Location(Plant) and Cust. Code use the explicitly supplied mappings in src/rejections/mappings.json. No Excel file is read.');
  const rawAcknowledgement=groups(items.filter(i=>i.x<.45&&i.y>.06&&i.y<.18)).map(g=>g.text).join('\n');
  const embeddedAck=parseAcknowledgement(rawAcknowledgement,invoiceDate),imageAck=parseAcknowledgement((page.ackOcr?.lines||[]).join('\n'),invoiceDate);
  const ack={};
  for(const field of ['number','date']){
    const values=[...new Set([embeddedAck[field],imageAck[field]].filter(Boolean))];
    ack[field]=values.length===1?values[0]:'';
    if(values.length>1)issue(`Conflicting PDF/OCR acknowledgement ${field}; inspect original page.`);
  }
  // Windows OCR has no confidence score and can mistake handwritten 77 for 74.
  // Only publish a complete pair supported by both independent text sources.
  const acknowledgementConfirmed=embeddedAck.number&&embeddedAck.date&&embeddedAck.number===imageAck.number&&embeddedAck.date===imageAck.date;
  if(!acknowledgementConfirmed){ack.number='';ack.date='';}
  if(page.ackOcr?.error)notes.push('Acknowledgement OCR: '+page.ackOcr.error);
  const packing=items.find(i=>/^Packing$/i.test(i.text)&&i.y>.3&&i.y<.7);
  if(!packing)throw Error('Unsupported rejection table: Packing header missing.');
  const headers=items.filter(i=>Math.abs(i.y-packing.y)<.035);
  const find=(pattern,min=0,max=1)=>headers.find(i=>pattern.test(i.text)&&i.x>=min&&i.x<max);
  const qty=find(/^QTY/i),basic=find(/^Basi[co]$/i,.42,packing.x),cgst=find(/^CGST$/i),sgst=find(/^SGST$/i);
  const unit=find(/^Basi[co]$/i,qty?.x, .43)||(/^QTYBasic$/i.test(qty?.text||'')?{x:qty.x+.028}:null);
  const total=find(/^Total$/i,sgst?.x,.89),tcs=find(/^(?:TCS|rcs)$/i,.8);
  const grand=items.find(i=>/^Grand$/i.test(i.text)&&i.y>packing.y);
  if(!qty||!unit||!basic||!cgst||!sgst||!total||!tcs||!grand)throw Error('Unsupported or incomplete rejection table headers.');
  const candidates=numbers(items);
  const cell=(left,right,y1,y2)=>groups(candidates.filter(i=>i.x>=left-.012&&i.x<right-.012&&i.y>=y1&&i.y<y2));
  const qrows=cell(qty.x,unit.x,packing.y+.025,grand.y-.012).map(g=>({...g,value:money(g.text)})).filter(g=>g.value);
  if(!qrows.length)throw Error('No readable line-item quantities; OCR or manual review required.');
  const rows=[],fieldRegions=[],sourceFields=[];
  const region=(left,right,y1,y2)=>({x:Math.max(0,left),y:Math.max(0,y1),width:Math.min(1,right)-Math.max(0,left),height:Math.min(1,y2)-Math.max(0,y1)});
  const around=(tokens)=>tokens.length?region(Math.min(...tokens.map(i=>i.x))-.004,Math.max(...tokens.map(i=>i.x+i.w))+.006,Math.min(...tokens.map(i=>i.y))-.013,Math.max(...tokens.map(i=>i.y))+.004):null;
  for(let index=0;index<qrows.length;index++){
    const q=qrows[index],next=qrows[index+1]?.y??grand.y;
    const low=q.y-.014,high=Math.min(q.y+.027,next-.014);
    const monetaryRegions=new Map();
    const get=(left,right)=>{
      const g=cell(left,right,low,high).find(g=>money(g.text));
      if(g)monetaryRegions.set(`${left}:${right}`,region(left-.012,right-.012,g.y-.012,g.y+.004));
      return g?money(g.text):'';
    };
    const partArea=items.filter(i=>i.x<qty.x-.02&&i.x>.07&&i.y>q.y-.028&&i.y<q.y+.012).sort((a,b)=>a.y-b.y||a.x-b.x).map(i=>i.text).join('');
    const itemName=extractItemName(partArea);
    const partName=partNameForItem(itemName);
    const partGroup=groups(items.filter(i=>i.x<qty.x-.065&&i.x>.07&&i.y>q.y-.04&&i.y<q.y+.006)).find(g=>!!extractItemName(g.text));
    const partLeft=items.find(i=>/^HSN$/i.test(i.text)&&i.x<qty.x&&Math.abs(i.y-q.y)<.025)?.x??.1;
    const descriptionGroups=groups(items.filter(i=>i.x>=partLeft-.02&&i.x<qty.x-.065&&i.y>q.y+.012&&i.y<Math.min(next-.012,grand.y-.012)))
      .filter(g=>/[A-Z]{2}/i.test(g.text)&&!/(?:HSN|\d{5})/i.test(g.text));
    const description=descriptionGroups.map(g=>g.text).join(' ').replace(/\bCRANKSHAF T\b/g,'CRANKSHAFT');
    if(itemName&&!partName)notes.push(`Item ${itemName} has no supplied part-name mapping; PART NAME intentionally left blank.`);
    const row=Object.fromEntries(COLUMNS.map(c=>[c,'']));
    Object.assign(row,{'Invoice Number':invoiceNumber,'Invoice Date':invoiceDate,'PART NAME':partName,'Item Name':itemName,'Qty':q.value.replace(/\.00$/,''),'Ack. No':ack.number,'Ack Date':ack.date,'Location(Plant)':plant?.location||'','Cust. Code':plant?.customerCode||'','Basic value':get(basic.x,packing.x),'Packing charges':get(packing.x,packing.x+(cgst.x-packing.x)/3),'CGST Amt.':get(cgst.x,sgst.x),'SGST Amt.':get(sgst.x,total.x)});
    sourceFields.push({itemNumberText:partArea,itemDescription:description,supplierLocation:location,printedBillToCode:customerCode});
    const price=get(unit.x,basic.x-(packing.x-basic.x));
    if(!price)issue(`Line ${index+1}: unit price unreadable; quantity/basic reconciliation requires review.`);
    if(row['Basic value']&&price&&productMinor(row.Qty,price)!==minor(row['Basic value']))issue(`Line ${index+1}: quantity times unit price does not match basic value.`);
    const fields=['Basic value','Packing charges','CGST Amt.','SGST Amt.'];
    let totalRegion=null;
    if(fields.every(f=>row[f])){
      const expected=fields.reduce((sum,f)=>sum+minor(row[f]),0n);
      const totals=cell(total.x-.004,tcs.x,low,grand.y+.015);
      const matchedTotal=totals.find(g=>money(g.text)&&minor(money(g.text))===expected);
      row['Total Value']=matchedTotal?money(matchedTotal.text):'';
      if(matchedTotal)totalRegion=region(total.x-.016,tcs.x-.012,matchedTotal.y-.012,matchedTotal.y+.004);
      if(!row['Total Value'])issue(`Line ${index+1}: printed total could not be reconciled with basic, packing and GST amounts.`);
    }
    if(!row['Ack. No']||!row['Ack Date'])issue('Handwritten acknowledgement could not be read reliably from the PDF. Review the saved page crop; no reference values were substituted.');
    for(const column of COLUMNS)if(row[column]===''&&column!=='PART NAME')issue(`Line ${index+1}: ${column} missing.`);
    rows.push(row);
    const dateAnchor=header.find(i=>/^DATE/i.test(i.text));
    fieldRegions.push({
      'Invoice Number':around([invoice]),
      'Invoice Date':dateAnchor?region(dateAnchor.x-.003,dateAnchor.x+.15,dateAnchor.y-.015,dateAnchor.y+.006):null,
      'PART NAME':partGroup?around(partGroup.items):null,
      'Item Name':partGroup?around(partGroup.items):null,
      'Qty':region(qty.x-.012,unit.x-.012,q.y-.012,q.y+.004),
      'Ack. No':region(.06,.44,.055,.18),'Ack Date':region(.06,.44,.055,.18),
      'Location(Plant)':postcode?around(items.filter(i=>Math.abs(i.y-postcode.y)<.004&&i.x>.2&&i.x<=postcode.x)):null,
      'Cust. Code':postcode?around(items.filter(i=>Math.abs(i.y-postcode.y)<.004&&i.x>.2&&i.x<=postcode.x)):null,
      'Basic value':monetaryRegions.get(`${basic.x}:${packing.x}`)||null,
      'Packing charges':monetaryRegions.get(`${packing.x}:${packing.x+(cgst.x-packing.x)/3}`)||null,
      'CGST Amt.':monetaryRegions.get(`${cgst.x}:${sgst.x}`)||null,
      'SGST Amt.':monetaryRegions.get(`${sgst.x}:${total.x}`)||null,
      'Total Value':totalRegion
    });
  }
  return {page:page.page,invoiceNumber,rows,fieldRegions,sourceFields,issues:[...new Set(issues)],notes:[...new Set(notes)],rawAcknowledgement,acknowledgementCandidates:{embeddedText:embeddedAck,imageOcr:imageAck,confirmed:!!acknowledgementConfirmed},ackOcr:page.ackOcr||null};
}
async function readPages(file){
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data=fs.readFileSync(file);if(data.subarray(0,5).toString()!=='%PDF-')throw Error('Not a PDF file.');
  const document=await getDocument({data:new Uint8Array(data),useSystemFonts:true,isEvalSupported:false}).promise;
  try{
    const pages=[];
    for(let n=1;n<=document.numPages;n++){
      const page=await document.getPage(n),view=page.getViewport({scale:1}),text=await page.getTextContent();
      pages.push({page:n,items:text.items.filter(i=>i.str).map(i=>({text:i.str,x:i.transform[4]/view.width,y:1-i.transform[5]/view.height,w:i.width/view.width}))});
    }
    return pages;
  }finally{await document.destroy();}
}
module.exports={COLUMNS,parsePage,readPages,parseAcknowledgement,date};
