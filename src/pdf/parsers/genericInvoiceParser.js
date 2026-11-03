const { gstins } = require('../validators/gstinValidator');
const { decimal } = require('../decimal');
const { extractIrn } = require('../extractIrn');
const first = (text, re) => text.match(re)?.[1]?.trim() || null;
function identifier(value) {
  return value && /\d/.test(value) && /^[A-Z0-9][A-Z0-9/()._-]{0,39}$/i.test(value) ? value : null;
}
function date(value) {
  if (!value) return null;
  let m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return value;
  m = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : null;
}
function genericInvoiceParser(text) {
  const rawDate = first(text, /(?:invoice\s*(?:date|dt\.?)|bill\s*date)[ \t:]*([^\n\t]+)/i);
  return {
    ...extractIrn(text),
    invoiceNumber: identifier(first(text, /(?:invoice\s*(?:no\.?|number|#)|bill\s*(?:no\.?|number))[ \t:#-]*([A-Z0-9/_.-]+)/i)),
    invoiceDate: date(rawDate), rawInvoiceDate: rawDate,
    sellerName: null, sellerGstin: null, buyerName: null, buyerGstin: null,
    vendorCode: identifier(first(text, /vendor\s*(?:code|id)[ \t:]*([A-Z0-9-]+)/i)),
    purchaseOrderNumber: identifier(first(text, /(?:P\.?\s*O\.?\s*No\.?|purchase\s*order\s*(?:no\.?|number))[ \t:]*([A-Z0-9/()._-]+)/i)),
    gstins: gstins(text), partNumbers: [], lineItems: [],
    taxableAmount: decimal(first(text, /(?:subtotal|total\s*taxable\s*(?:value|amount))[ \t:]*([\d,]+\.\d{2})/i)),
    cgst: decimal(first(text, /\bCGST[ \t:]+([\d,]+\.\d{2})/i)),
    sgst: decimal(first(text, /\bSGST[ \t:]+([\d,]+\.\d{2})/i)),
    igst: decimal(first(text, /\bIGST[ \t:]+([\d,]+\.\d{2})/i)),
    totalAmount: decimal(first(text, /(?:grand\s*total|invoice\s*total|total\s*amount)[ \t:₹]*(?:Rs\.?[ \t]*)?([\d,]+(?:\.\d{2})?)/i)),
    evidence: ['Generic labeled-field extraction; party roles and table layout require review']
  };
}
module.exports = { genericInvoiceParser, first, identifier, date };
