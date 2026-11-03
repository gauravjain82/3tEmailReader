const { genericInvoiceParser, first, date } = require('./genericInvoiceParser');
const { decimal } = require('../decimal');
function hubInvoiceParser(text) {
  const doc = genericInvoiceParser(text);
  const header = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\w{15})\s+(\d{6,20})\s+Date\s+Invoice No/i);
  doc.invoiceNumber = header?.[3] || null;
  doc.rawInvoiceDate = header?.[1] || null;
  doc.invoiceDate = date(doc.rawInvoiceDate);
  doc.sellerGstin = header?.[2] || null;
  doc.sellerName = first(text, /^(Samvardhana Motherson[^\n]+)/mi);
  const billed = text.split(/Bill To\s*:/i)[1]?.split(/Ship To\s*:/i)[0] || '';
  doc.buyerName = first(billed, /^(MARUTI[^\n]+)/mi);
  doc.buyerGstin = first(billed, /GSTIN No\.[ \t:]*([A-Z0-9]{15})/i);
  doc.vendorCode = first(text, /(?:^|\n)([A-Z][A-Z0-9-]*\d[A-Z0-9-]*)[ \t]+Vendor Code/i);
  doc.purchaseOrderNumber = first(text, /(?:^|\n)([A-Z0-9/()._-]+)[ \t]+Customer PO No\./i);
  doc.totalAmount = decimal(first(text, /Total Invoice value \(A \+ B \+ C \+ D- E\)\s+Advance Received \(E\)\s+([\d,.]+)/i));
  const row = /(?:^|\n)([\d.]+)[ \t]+([\d.]+)[ \t]+([\d.]+)[ \t]+([\d,.]+)[ \t]+(\d{4,8})[ \t]+(\w+)[ \t]+(\d+)[ \t]+%[ \t]+%[ \t]+%[ \t]+([\d,.]+)[ \t]+([\d,.]+)\s*\n([\d,.]+)[ \t]+([\d,.]+)[ \t]+([\d,.]+)[ \t]+([\d,.]+)[ \t]+(NOS|PC|EA|KG)[ \t]+([^\n]+?)[ \t]+([\d,.]+)\s*\n([A-Z0-9/-]+)/g;
  const seen = new Set();
  for (const m of text.matchAll(row)) {
    const key = m.slice(1).join('|'); if (seen.has(key)) continue; seen.add(key);
    doc.lineItems.push({ lineNumber: Number(m[7]), itemCode: m[6], partNumber: m[17], description: m[15].trim(), hsnSac: m[5], quantity: decimal(m[4], 6), unitPrice: decimal(m[8], 6), unit: m[14], taxableAmount: decimal(m[12]), cgstRate: decimal(m[3]), cgst: decimal(m[11]), sgstRate: decimal(m[2]), sgst: decimal(m[10]), igstRate: decimal(m[1]), igst: decimal(m[16]) });
  }
  const totals = text.match(/(?:^|\n)([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+Total Value/i);
  doc.cgst = decimal(totals?.[1]); doc.sgst = decimal(totals?.[2]); doc.igst = decimal(totals?.[3]); doc.taxableAmount = decimal(totals?.[4]);
  doc.partNumbers = [...new Set(doc.lineItems.map(i => i.partNumber))];
  doc.evidence = ['Motherson/HUB values-before-labels header and reversed tax-column table layout'];
  return doc;
}
module.exports = { hubInvoiceParser };
