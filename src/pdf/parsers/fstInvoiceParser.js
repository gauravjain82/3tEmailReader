const { genericInvoiceParser, first, date } = require('./genericInvoiceParser');
const { decimal } = require('../decimal');
function fstInvoiceParser(text) {
  const doc = genericInvoiceParser(text);
  doc.rawInvoiceDate = first(text, /^Date:[ \t]*(\S+)/m);
  doc.invoiceDate = date(doc.rawInvoiceDate);
  doc.sellerName = first(text, /^(Freudenberg[^\n]+)/mi);
  doc.sellerGstin = first(text, /GST\s*NO\s*:\s*(\w{15})/i);
  const buyer = text.match(/Billed to:[^\n]*\n([^\n]+)([\s\S]*?)(?:Sr\.No|Shipped To:)/i);
  doc.buyerName = buyer?.[1]?.trim() || null;
  doc.buyerGstin = first(text.slice(text.indexOf('Billed to:')), /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b/);
  // One row spans description lines followed by the customer part/HSN/numeric columns.
  const row = /(?:^|\n)(\d{1,3})[ \t]+([\s\S]*?)\s+([A-Z0-9/-]+)[ \t]+(\d{4,8})[ \t]+([\d,.]+)[ \t]+(PC|NOS|EA|KG)[ \t]+([\d,.]+)[ \t]+([\d,.]+)[ \t]+([\d,.]+)[ \t]+([\d,.]+)[ \t]+([\d,.]+)[ \t]+([\d,.]+)[ \t]+([\d,.]+)/g;
  const seen = new Set();
  const tables = [...text.matchAll(/Rate Amt Rate Amt\s*\n([\s\S]*?)(?=Total Invoice Value)/gi)].map(m => m[1]);
  for (const m of tables.join('\n').matchAll(row)) {
    const key = m.slice(1).join('|');
    if (seen.has(key)) continue; // Recipient/transporter/assessee copies are not extra goods.
    seen.add(key);
    doc.lineItems.push({ lineNumber: Number(m[1]), description: m[2].replace(/\s+/g,' ').trim(), partNumber: m[3], hsnSac: m[4], quantity: decimal(m[5], 6), unit: m[6], unitPrice: decimal(m[7], 6), priceUnit: decimal(m[8], 6), taxableAmount: decimal(m[9]), cgstRate: decimal(m[10]), cgst: decimal(m[11]), sgstRate: decimal(m[12]), sgst: decimal(m[13]), igst: '0.00' });
  }
  doc.partNumbers = [...new Set(doc.lineItems.map(i => i.partNumber))];
  doc.igst = '0.00';
  doc.evidence = ['FST labeled header and customer-part/HSN table layout', 'Repeated identical invoice-copy rows deduplicated'];
  return doc;
}
module.exports = { fstInvoiceParser };
