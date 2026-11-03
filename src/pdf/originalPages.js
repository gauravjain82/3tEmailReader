const crypto = require('crypto');
const { parseInvoice } = require('./parserRegistry');
const { normalizeInvoiceNumber } = require('../storage/invoiceIdentity');
const { detectDocumentType } = require('./detectDocumentType');
const { normalizePdfText } = require('./normalizePdfText');

function selectOriginalPages(pages, expectedNumber) {
  const expected = normalizeInvoiceNumber(expectedNumber);
  if (!expected || !pages.length) throw Error('An identifiable invoice number and PDF pages are required');
  const info = pages.map(page=>{
    page={...page,text:normalizePdfText(page.text)};
    const header=page.text.slice(0,1200);
    const original=/\boriginal\s+(?:copy\s+)?for\s+(?:recipient|buyer|customer)\b/i.test(header) || /^\s*original(?:\s+copy)?\s*$/mi.test(header);
    const other=/\b(?:duplicate|triplicate|quadruplicate|extra)\s+(?:copy|for\b)|\bcopy\s+for\s+(?:transporter|supplier|assessee)\b/i.test(header);
    const type=detectDocumentType(page.text).type;
    const number=type==='TAX_INVOICE' ? normalizeInvoiceNumber(parseInvoice(page.text).invoiceNumber) : null;
    if (number && number!==expected) throw Error('PDF contains a different invoice number; original pages require review');
    if (original && other) throw Error('Conflicting original/copy labels on a PDF page');
    return {...page,original,other,type,number};
  });
  if (info.length===1 && !info[0].other && info[0].type==='TAX_INVOICE' && info[0].number===expected) return [0];
  if (!info.some(p=>p.original)) throw Error('Original-recipient pages cannot be identified in this multi-page PDF');
  const selected=[],seen=new Set();
  let active=false,ended=false;
  for (let index=0;index<info.length;index++) {
    const page=info[index];
    if (page.other || ['BIN_TAG','COLOUR_CODE_DOCUMENT','OTHER'].includes(page.type)) {
      if (active) ended=true;
      active=false;continue;
    }
    if (page.original && !ended) active=true;
    if (!active || !page.text.trim()) continue;
    const normalized=page.text.replace(/\bpage\s+\d+\s+of\s+\d+\b/gi,'').replace(/\s+/g,' ').trim();
    const hash=crypto.createHash('sha256').update(normalized).digest('hex');
    if (seen.has(hash)) continue;
    seen.add(hash);selected.push(index);
  }
  if (!selected.length) throw Error('No original-recipient pages found');
  if (!selected.some(index=>info[index].number===expected)) throw Error('Invoice number could not be verified on the original-recipient pages');
  return selected;
}
module.exports = { selectOriginalPages };
