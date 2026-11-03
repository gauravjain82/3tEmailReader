const { genericInvoiceParser, first } = require('./genericInvoiceParser');
const { decimal } = require('../decimal');
function mahleDate(value) {
  const m=value?.match(/^(\d{2})-([A-Z]{3})-(\d{2}|\d{4})$/i);
  if (!m) return null;
  const month=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(m[2].toUpperCase())+1;
  return month ? `${m[3].length===2?'20'+m[3]:m[3]}-${String(month).padStart(2,'0')}-${m[1]}` : null;
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
  doc.partNumbers=doc.lineItems.map(i=>i.partNumber);
  doc.evidence=['MAHLE invoice header, receiver GSTIN and table layout checked against supplied PDFs','Two-digit invoice years in this template interpreted as 20xx'];
  if (parts.length!==1) doc.evidence.push('Unsupported or ambiguous MAHLE item layout requires review');
  return doc;
}
module.exports = { mahleInvoiceParser, mahleDate };
