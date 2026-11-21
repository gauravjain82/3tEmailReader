const {unzipSync,zipSync,strFromU8,strToU8}=require('fflate');
const {DOMParser,XMLSerializer}=require('@xmldom/xmldom');
const path=require('path');
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const elements=(node,tag)=>Array.from(node.getElementsByTagNameNS(NS,tag));
function xml(bytes){const text=strFromU8(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Unsupported workbook XML entities');return new DOMParser({onError:(level,message)=>{if(level!=='warning')throw Error(message);}}).parseFromString(text,'application/xml');}
const serialize=doc=>strToU8(new XMLSerializer().serializeToString(doc));
const column=ref=>ref.match(/^[A-Z]+/)[0];
const columnIndex=value=>[...value].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);

class Sheet{
  constructor(book,name,file){this.book=book;this.name=name;this.file=file;this.doc=xml(book.files[file]);this.data=elements(this.doc,'sheetData')[0];if(!this.data)throw Error('Missing workbook rows: '+name);this.rows=new Map();this.cells=new Map();this.dirty=false;for(const row of elements(this.data,'row')){this.rows.set(Number(row.getAttribute('r')),row);for(const cell of elements(row,'c'))this.cells.set(cell.getAttribute('r'),cell);}}
  value(ref){const cell=this.cells.get(ref);if(!cell)return '';const type=cell.getAttribute('t');if(type==='inlineStr')return elements(cell,'t').map(t=>t.textContent).join('');const value=elements(cell,'v')[0]?.textContent||'';return type==='s'?this.book.strings[Number(value)]||'':value;}
  formula(ref){return elements(this.cells.get(ref)||this.doc.createElement('empty'),'f')[0]?.textContent||'';}
  maxRow(){return Math.max(0,...this.rows.keys());}
  set(ref,value,{styleFrom,formula}={}){
    const old=this.cells.get(ref),wasBlank=this.value(ref)===''&&!this.formula(ref);if((formula||'')===this.formula(ref)&&this.value(ref)===String(value??'')&&old?.getAttribute('t')!=='e')return;
    const rowNo=Number(ref.match(/\d+$/)[0]);let row=this.rows.get(rowNo);
    if(!row){row=this.doc.createElementNS(NS,'row');row.setAttribute('r',rowNo);const after=[...this.rows.keys()].sort((a,b)=>a-b).find(n=>n>rowNo);this.data.insertBefore(row,after?this.rows.get(after):null);this.rows.set(rowNo,row);}
    let cell=old;
    if(!cell){cell=this.doc.createElementNS(NS,'c');cell.setAttribute('r',ref);const next=elements(row,'c').find(c=>columnIndex(column(c.getAttribute('r')))>columnIndex(column(ref)));row.insertBefore(cell,next||null);this.cells.set(ref,cell);}
    // Preformatted empty cells already exist in the supplied sales workbook.
    // They still need the previous data row's date/number styles when filled.
    if(wasBlank&&styleFrom){const template=this.cells.get(styleFrom);if(template){const style=template.getAttribute('s');if(style)cell.setAttribute('s',style);else cell.removeAttribute('s');}}
    while(cell.firstChild)cell.removeChild(cell.firstChild);cell.removeAttribute('t');
    if(formula){const f=this.doc.createElementNS(NS,'f');f.appendChild(this.doc.createTextNode(formula));cell.appendChild(f);}
    if(value!=null&&value!==''){
      if(typeof value==='string'&&!formula){cell.setAttribute('t','inlineStr');const is=this.doc.createElementNS(NS,'is'),t=this.doc.createElementNS(NS,'t');t.setAttribute('xml:space','preserve');t.appendChild(this.doc.createTextNode(value));is.appendChild(t);cell.appendChild(is);}
      else {const v=this.doc.createElementNS(NS,'v');v.appendChild(this.doc.createTextNode(String(value)));cell.appendChild(v);}
    }
    this.dirty=true;
  }
  number(ref,value,options={}){this.set(ref,Number(value),options);}
  copyStyle(ref,styleFrom,fallback){
    const source=this.cells.get(styleFrom)?.getAttribute('s')||this.cells.get(fallback)?.getAttribute('s');if(!source)return;
    let cell=this.cells.get(ref);
    if(!cell){const rowNo=Number(ref.match(/\d+$/)[0]);let row=this.rows.get(rowNo);if(!row){row=this.doc.createElementNS(NS,'row');row.setAttribute('r',rowNo);const after=[...this.rows.keys()].sort((a,b)=>a-b).find(n=>n>rowNo);this.data.insertBefore(row,after?this.rows.get(after):null);this.rows.set(rowNo,row);}cell=this.doc.createElementNS(NS,'c');cell.setAttribute('r',ref);const next=elements(row,'c').find(c=>columnIndex(column(c.getAttribute('r')))>columnIndex(column(ref)));row.insertBefore(cell,next||null);this.cells.set(ref,cell);}
    if(cell.getAttribute('s')!==source){cell.setAttribute('s',source);this.dirty=true;}
  }
  updateRange(){const dimension=elements(this.doc,'dimension')[0];if(dimension){const end=dimension.getAttribute('ref').split(':').pop();const lastRow=Math.max(Number(end.match(/\d+$/)[0]),this.maxRow());dimension.setAttribute('ref',`A1:${column(end)}${lastRow}`);}const filter=elements(this.doc,'autoFilter')[0];if(filter){const [start,end]=filter.getAttribute('ref').split(':');if(end)filter.setAttribute('ref',`${start}:${column(end)}${Math.max(Number(end.match(/\d+$/)[0]),this.maxRow())}`);}}
}

class Workbook{
  constructor(bytes){if(bytes.length>50*1024*1024)throw Error('Workbook is too large');let expanded=0;this.files=unzipSync(bytes,{filter:entry=>{expanded+=entry.originalSize;if(expanded>256*1024*1024||entry.originalSize>64*1024*1024)throw Error('Expanded workbook size limit exceeded');return true;}});if(!this.files['xl/workbook.xml'])throw Error('Not an XLSX workbook');this.doc=xml(this.files['xl/workbook.xml']);this.strings=this.files['xl/sharedStrings.xml']?elements(xml(this.files['xl/sharedStrings.xml']),'si').map(si=>elements(si,'t').map(t=>t.textContent).join('')):[];this.date1904=elements(this.doc,'workbookPr')[0]?.getAttribute('date1904')==='1';const rels=xml(this.files['xl/_rels/workbook.xml.rels']);const byId=new Map(Array.from(rels.documentElement.childNodes).filter(n=>n.nodeType===1).map(r=>[r.getAttribute('Id'),r.getAttribute('Target')]));this.sheets=new Map();for(const sheet of elements(this.doc,'sheet')){const target=byId.get(sheet.getAttribute('r:id'));const file=target.startsWith('/')?target.slice(1):path.posix.normalize('xl/'+target);if(!this.files[file])throw Error('Missing worksheet '+file);this.sheets.set(sheet.getAttribute('name'),new Sheet(this,sheet.getAttribute('name'),file));}}
  sheet(name){const sheet=this.sheets.get(name);if(!sheet)throw Error('Required worksheet missing: '+name);return sheet;}
  addSheet(name,{widths=[]}={}){
    if(!name||name.length>31||/[\\/?*\[\]:]/.test(name)||[...this.sheets.keys()].some(n=>n.toLowerCase()===name.toLowerCase()))throw Error('Invalid or duplicate worksheet name: '+name);
    let number=1;while(this.files[`xl/worksheets/sheet${number}.xml`])number++;
    const file=`xl/worksheets/sheet${number}.xml`,rels=xml(this.files['xl/_rels/workbook.xml.rels']),relNS=rels.documentElement.namespaceURI;
    const ids=new Set(Array.from(rels.documentElement.childNodes).filter(n=>n.nodeType===1).map(n=>n.getAttribute('Id')));let id=1;while(ids.has('rId'+id))id++;
    const relationship=rels.createElementNS(relNS,'Relationship');relationship.setAttribute('Id','rId'+id);relationship.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet');relationship.setAttribute('Target',`worksheets/sheet${number}.xml`);rels.documentElement.appendChild(relationship);this.files['xl/_rels/workbook.xml.rels']=serialize(rels);
    const types=xml(this.files['[Content_Types].xml']),override=types.createElementNS(types.documentElement.namespaceURI,'Override');override.setAttribute('PartName','/'+file);override.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');types.documentElement.appendChild(override);this.files['[Content_Types].xml']=serialize(types);
    const entry=this.doc.createElementNS(NS,'sheet');entry.setAttribute('name',name);entry.setAttribute('sheetId',Math.max(0,...elements(this.doc,'sheet').map(s=>Number(s.getAttribute('sheetId'))))+1);entry.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','r:id','rId'+id);elements(this.doc,'sheets')[0].appendChild(entry);
    this.files[file]=strToU8(`<worksheet xmlns="${NS}"><dimension ref="A1:J1"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${widths.length?'<cols>'+widths.map((width,i)=>`<col min="${i+1}" max="${i+1}" width="${Number(width)}" customWidth="1"/>`).join('')+'</cols>':''}<sheetData/><autoFilter ref="A1:J1"/></worksheet>`);
    const sheet=new Sheet(this,name,file);sheet.dirty=true;this.sheets.set(name,sheet);return sheet;
  }
  focus(name,row){
    const names=[...this.sheets.keys()],index=names.indexOf(name);if(index<0)throw Error('Worksheet not found: '+name);
    const view=elements(this.doc,'workbookView')[0];if(view)view.setAttribute('activeTab',index);
    for(const [sheetName,sheet] of this.sheets){const views=elements(sheet.doc,'sheetView');for(const item of views){if(sheetName===name)item.setAttribute('tabSelected','1');else item.removeAttribute('tabSelected');}if(views.length)sheet.dirty=true;}
    const sheet=this.sheet(name),sheetView=elements(sheet.doc,'sheetView')[0];if(!sheetView)return;
    const pane=elements(sheetView,'pane')[0],selections=elements(sheetView,'selection');
    if(pane){pane.setAttribute('topLeftCell','A'+Math.max(2,row-10));const selection=selections.find(s=>s.getAttribute('pane')==='bottomLeft')||selections.at(-1);if(selection){selection.setAttribute('activeCell','B'+row);selection.setAttribute('sqref','B'+row+':L'+row);}}
    else {sheetView.setAttribute('topLeftCell','A'+Math.max(1,row-10));let selection=selections[0];if(!selection){selection=sheet.doc.createElementNS(NS,'selection');sheetView.appendChild(selection);}selection.setAttribute('activeCell','B'+row);selection.setAttribute('sqref','B'+row+':L'+row);}
  }
  serial(date){return (Date.parse(date+'T00:00:00Z')-Date.parse(this.date1904?'1904-01-01T00:00:00Z':'1899-12-30T00:00:00Z'))/86400000;}
  date(serial){const time=Date.parse(this.date1904?'1904-01-01T00:00:00Z':'1899-12-30T00:00:00Z')+Number(serial)*86400000;return Number.isFinite(time)?new Date(time).toISOString().slice(0,10):null;}
  get dirty(){return [...this.sheets.values()].some(s=>s.dirty);}
  pack(){
    for(const sheet of this.sheets.values())if(sheet.dirty){sheet.updateRange();this.files[sheet.file]=serialize(sheet.doc);}
    // Rebuild Excel's calculation order on open; untouched package parts stay intact.
    delete this.files['xl/calcChain.xml'];
    for(const file of ['xl/_rels/workbook.xml.rels','[Content_Types].xml']){const doc=xml(this.files[file]);for(const node of Array.from(doc.documentElement.childNodes))if(node.nodeType===1&&/calcChain\.xml$/.test(node.getAttribute('Target')||node.getAttribute('PartName')||''))node.parentNode.removeChild(node);this.files[file]=serialize(doc);}
    let calc=elements(this.doc,'calcPr')[0];if(!calc){calc=this.doc.createElementNS(NS,'calcPr');const ext=elements(this.doc,'extLst')[0];this.doc.documentElement.insertBefore(calc,ext||null);}calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1');this.files['xl/workbook.xml']=serialize(this.doc);return Buffer.from(zipSync(this.files,{level:6}));
  }
}
module.exports={Workbook,NS,elements};
