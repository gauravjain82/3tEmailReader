const {extractText}=require('../pdf/extractText');
const {decimal,minor,sum,productMinor,taxMinor}=require('../pdf/decimal');
const {validDate}=require('../pdf/validators/invoiceValidator');

function locationFor(buyer,shipping){
  const code=buyer.match(/\((C\d+)\)/i)?.[1]?.toUpperCase();
  const codes={C100364:'SMG',C100336:'MSILK',C100084:'MSILM',C100167:'MSILM OES',C100125:'MSILG SPD',C100102:'MSILG'};
  const place=/Ahmedabad|Gujarat|Hansalpur|Becharaji/i.test(shipping)?'SMG':/Kharkhoda/i.test(shipping)?'MSILK':/Manesar/i.test(shipping)?'MSILM':/Gurgaon|Gurugram/i.test(shipping)?'MSILG':null;
  const plant=codes[code]||place;
  if(!plant||!place||!plant.startsWith(place))throw Error('Unknown or conflicting Norma ship-to location');
  return {plant,region:plant==='SMG'?'gujarat':'gurgaon',customerCode:code||null};
}
function parsePage(text){
  if(!/NORMA Group Products India Private Limited/i.test(text)||!/Tax Invoice/i.test(text))throw Error('Not a supported Norma tax invoice');
  const buyer=text.match(/Name of The Customer \(Bill To\):\s*([^\n]+)/i)?.[1];
  const shipping=text.match(/Name of The Customer \(Ship To\):([\s\S]*?)Invoice No\.:/i)?.[1];
  if(!buyer||!shipping)throw Error('Norma buyer/ship-to details missing');
  const invoiceNumber=text.match(/ASN:\s*\n(\d{8,14})\s*\n/)?.[1];
  const head=text.split('Norma Part No')[0];
  const dates=[...new Set([...head.matchAll(/\b(\d{2})\/(\d{2})\/(20\d{2})\b/g)].map(m=>`${m[3]}-${m[2]}-${m[1]}`))];
  if(!invoiceNumber||dates.length!==1||!validDate(dates[0]))throw Error('Missing or ambiguous Norma invoice number/date');
  const table=text.match(/RATE % Amount RATE % Amount RATE % Amount\s*\n([\s\S]*?)\nTotals\s+([^\n]+)/);
  if(!table)throw Error('Unsupported Norma invoice table');
  const number='([\\d,]+\\.\\d+)';
  const rowPattern=new RegExp('^(\\d{8,14})\\s+(\\d{4,8})\\s+'+number+'\\s+(pcs|nos|ea|kg)\\s+'+Array(11).fill(number).join('\\s+')+'\\s+([A-Z0-9][A-Z0-9/-]+)[ \\t]+([^\\n]+)[ \\t]*$','gmi');
  const items=[];
  for(const m of table[1].matchAll(rowPattern)){
    const item={normaPartNumber:m[1],hsn:m[2],quantity:decimal(m[3],6),unit:m[4],unitPrice:decimal(m[5],6),value:decimal(m[6]),freight:decimal(m[7]),igstRate:decimal(m[8]),total:decimal(m[9]),cgstRate:decimal(m[10]),cgst:decimal(m[11]),taxable:decimal(m[12]),sgst:decimal(m[13]),sgstRate:decimal(m[14]),igst:decimal(m[15]),partNumber:m[16],description:m[17].trim()};
    if(Object.values(item).some(v=>v==null)||!/^\d{5}M[A-Z0-9]+(?:-[A-Z0-9]+)?$/.test(item.partNumber))throw Error('Incomplete Norma item values');
    const near=(a,b)=>a-b>=-1n&&a-b<=1n;
    if(!near(productMinor(item.quantity,item.unitPrice),minor(item.value))||BigInt(item.quantity.replace('.',''))<=0n||minor(item.value)+minor(item.freight)!==minor(item.taxable))throw Error('Norma quantity/rate/taxable values do not reconcile');
    for(const tax of ['cgst','sgst','igst'])if(!near(taxMinor(item.taxable,item[tax+'Rate']),minor(item[tax])))throw Error('Norma item tax does not reconcile');
    if(sum([item.taxable,item.cgst,item.sgst,item.igst])!==minor(item.total))throw Error('Norma item grand total does not reconcile');
    items.push(item);
  }
  if(!items.length||table[1].replace(rowPattern,'').trim())throw Error('Unsupported or incomplete Norma item rows');
  const totals=table[2].trim().split(/\s+/).map(v=>decimal(v));
  if(totals.length!==8||totals.some(v=>v==null))throw Error('Missing Norma invoice totals');
  const fields=['quantity','value','freight','taxable','cgst','sgst','igst','total'];
  fields.forEach((field,i)=>{const actual=field==='quantity'?items.reduce((s,item)=>s+BigInt(item.quantity.replace('.','')),0n):sum(items.map(item=>item[field]));const expected=field==='quantity'?BigInt(decimal(totals[i],6).replace('.','')):minor(totals[i]);if(actual!==expected)throw Error('Norma invoice '+field+' does not match its items');});
  const location=locationFor(buyer,shipping);
  if(location.region==='gujarat'&&items.some(i=>minor(i.cgst)!==0n||minor(i.sgst)!==0n)||location.region==='gurgaon'&&items.some(i=>minor(i.igst)!==0n))throw Error('Norma tax type does not match the destination sheet');
  return {invoiceNumber,date:dates[0],buyer,shipping:shipping.trim(),...location,items};
}
function parseNormaText(text){
  const pages=text.split(/--\s*\d+\s+of\s+\d+\s*--/).filter(t=>/NORMA Group Products India/i.test(t));
  if(!pages.length)throw Error('No Norma invoice pages found');
  const invoices=new Map();
  const groups=new Map();
  for(const page of pages){const number=page.match(/ASN:\s*\n(\d{8,14})\s*\n/)?.[1];if(!number)throw Error('Missing Norma invoice page identity');if(!groups.has(number))groups.set(number,[]);groups.get(number).push(page);}
  for(const copies of groups.values()){
    const originals=copies.filter(t=>/ORIGINAL FOR BUYER/i.test(t));
    for(const page of originals.length?originals:copies){
      const doc=parsePage(page),old=invoices.get(doc.invoiceNumber);
      if(old&&JSON.stringify(old)!==JSON.stringify(doc))throw Error('Conflicting or unsupported multi-page Norma invoice '+doc.invoiceNumber);
      invoices.set(doc.invoiceNumber,doc);
    }
  }
  return [...invoices.values()];
}
async function parseNormaPdf(bytes){return parseNormaText(await extractText(bytes));}
module.exports={parseNormaPdf,parseNormaText,locationFor};
