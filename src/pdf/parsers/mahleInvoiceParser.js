const { genericInvoiceParser, first } = require('./genericInvoiceParser');
const { decimal } = require('../decimal');
function mahleDate(value) {
  const m=value?.match(/^(\d{2})-([A-Z]{3})-(\d{2}|\d{4})$/i);
  if (!m) return null;
  const month=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(m[2].toUpperCase())+1;
  return month ? `${m[3].length===2?'20'+m[3]:m[3]}-${String(month).padStart(2,'0')}-${m[1]}` : null;
}
function mahleMultiLineItems(text,parts) {
  // This PDF's text stream stores columns together, rather than row by row.
  // Require every labeled column to have exactly one value per printed line.
  const table=text.match(/(?:^|\n)((?:[ \t]*\d+[ \t]*\n)+)Sr # Description of Goods\s*\n([\s\S]*?)\nQty\s*\n([\s\S]*?)\nRate\s*\nper Unit\s*\n([\s\S]*?)\nRate%\s*\n([\s\S]*?)\nAmt\.\s*\n([\s\S]*?)\nOur GSTIN Number/i);
  const identity=text.match(/HSN\/\s*SAC\s*\n([\s\S]*?)\nUnit\s*\n([\s\S]*?)\nTaxable\s*\nValue\s*\n([\s\S]*?)\n[^\n]+\n[^\n]+\nAddress\s*:/i);
  if(!table||!identity)return [];
  const lines=value=>value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const [serials,quantities,prices,taxableAndRates,cgstAmounts,remaining]=table.slice(1).map(lines);
  const [hsns,units,descriptions]=identity.slice(1).map(lines),n=serials.length;
  if(n<2||n!==parts.length||new Set(serials).size!==n||!serials.every(s=>/^\d{1,4}$/.test(s)&&Number(s)>0))return [];
  if([quantities,prices,cgstAmounts,hsns,units,descriptions].some(column=>column.length!==n)||taxableAndRates.length!==2*n||remaining.length!==4*n)return [];
  const numeric=[...quantities,...prices,...taxableAndRates,...cgstAmounts,...remaining];
  const normalized=value=>value.startsWith('.')?'0'+value:value;
  if(!numeric.every(s=>/^(?:\d[\d,]*(?:\.\d+)?|\.\d+)$/.test(s)&&decimal(normalized(s),6)!==null))return [];
  if(!hsns.every(s=>/^\d{4,8}$/.test(s))||!units.every(s=>/^[A-Z]{1,8}$/i.test(s))||!descriptions.every(s=>/[A-Z]/i.test(s)))return [];
  const amount=value=>decimal(normalized(value));
  const rows=serials.map((serial,i)=>({lineNumber:Number(serial),partNumber:parts[i][1],description:descriptions[i],hsnSac:hsns[i],unit:units[i],quantity:decimal(normalized(quantities[i]),6),unitPrice:decimal(normalized(prices[i]),6),taxableAmount:amount(taxableAndRates[i]),cgstRate:amount(taxableAndRates[n+i]),cgst:amount(cgstAmounts[i]),sgstRate:amount(remaining[i]),sgst:amount(remaining[n+i]),igstRate:amount(remaining[2*n+i]),igst:amount(remaining[3*n+i])}));
  if(rows.some(r=>['quantity','unitPrice','taxableAmount','cgstRate','cgst','sgstRate','sgst','igstRate','igst'].some(f=>r[f]===null)))return [];
  return rows;
}
function mahleInvoiceParser(text) {
  const doc=genericInvoiceParser(text);
  const header=text.match(/TAX INVOICE\s*\n(\d{6,20})\s*\n(\d{2}-[A-Z]{3}-(?:\d{4}|\d{2}))/i);
  doc.invoiceNumber=header?.[1] || null;doc.rawInvoiceDate=header?.[2] || null;doc.invoiceDate=mahleDate(doc.rawInvoiceDate);
  doc.sellerName=first(text,/^(MAHLE ENGINE COMPONENTS INDIA[^\n]+)/mi);
  doc.sellerGstin=first(text,/Our GSTIN Number\s+(\w{15})/i);
  doc.buyerName=first(text,/^([^\n]+)[\t ]+Name\s*:/mi);
  doc.buyerGstin=first(text,/Name\s*:\s*\n(\w{15})/i);
  doc.purchaseOrderNumber=first(text,/P\.O\.-([A-Z0-9/()_-]+)/i);
  const money='([\\d,]*\\.\\d{2})';
  const total=text.match(new RegExp(money+'\\s+Total:\\s*'+money+'\\s+'+money+'\\s+'+money,'i'));
  const amount=value=>decimal(value?.startsWith('.')?'0'+value:value);
  doc.taxableAmount=amount(total?.[1]);doc.cgst=amount(total?.[2]);doc.sgst=amount(total?.[3]);doc.igst=amount(total?.[4]);
  doc.totalAmount=amount(first(text,/Total Invoice Value \(In Words\)\s*\n\s*([\d,]+\.\d{2})/i));
  const parts=[...text.matchAll(/\bPART NO\s+([A-Z0-9/-]+)/gi)];
  const row=text.match(new RegExp('(?:^|\\n)(\\d+)\\s*\\nSr # Description of Goods\\s*\\n([\\d,.]+)\\s*\\nQty\\s*\\n\\s*'+money+'\\s*\\nRate\\s*\\nper Unit\\s*\\n\\s*'+money+'\\s+([\\d.]+)\\s*\\nRate%\\s*\\n\\s*'+money+'\\s*\\nAmt\\.\\s*\\n([\\d.]+)\\s+'+money+'\\s+([\\d.]+)\\s+'+money,'i'));
  const identity=text.match(/HSN\/\s*SAC\s*\n(\d{4,8})\s*\nUnit\s*\n(\w+)\s*\nTaxable\s*\nValue\s*\n([^\n]+)/i);
  if (row && identity && parts.length===1) doc.lineItems.push({lineNumber:Number(row[1]),partNumber:parts[0][1],description:identity[3].trim(),hsnSac:identity[1],unit:identity[2],quantity:decimal(row[2],6),unitPrice:decimal(row[3],6),taxableAmount:amount(row[4]),cgstRate:decimal(row[5]),cgst:amount(row[6]),sgstRate:decimal(row[7]),sgst:amount(row[8]),igstRate:decimal(row[9]),igst:amount(row[10])});
  else if(parts.length>1)doc.lineItems=mahleMultiLineItems(text,parts);
  doc.partNumbers=doc.lineItems.map(i=>i.partNumber);
  doc.evidence=['MAHLE invoice header, receiver GSTIN and table layout checked against supplied PDFs','Two-digit invoice years in this template interpreted as 20xx'];
  if(doc.lineItems.length>1)doc.evidence.push('MAHLE multi-row columns checked for matching serial, part, quantity, price, tax, HSN, unit and description counts; repeated part numbers retained as separate item rows.');
  if (!doc.lineItems.length) doc.evidence.push('Unsupported or ambiguous MAHLE item layout requires review');
  return doc;
}
module.exports = { mahleInvoiceParser, mahleDate };
