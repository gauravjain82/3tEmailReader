const { validateGstin } = require('./gstinValidator');
const { minor, sum, productMinor, taxMinor } = require('../decimal');
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === value;
}
function validateInvoice(doc) {
  const issues = [], checks = [];
  const issue = (field, reason) => issues.push({ field, reason });
  if (['BIN_TAG', 'COLOUR_CODE_DOCUMENT', 'OTHER'].includes(doc.documentType)) return { status: 'NOT_APPLICABLE', issues, checks: ['Non-invoice document'] };
  if (doc.documentType !== 'TAX_INVOICE') issue('documentType', 'Document type requires review');
  if (!doc.invoiceNumber || !/\d/.test(doc.invoiceNumber)) issue('invoiceNumber', 'Missing or invalid invoice number');
  if (!validDate(doc.invoiceDate)) issue('invoiceDate', 'Missing or invalid calendar date');
  if (doc.irnCandidates?.length>1) issue('irn', 'Conflicting IRN values in the PDF require review');
  if (doc.ewayBillCandidates?.length>1) issue('ewayBillNumber', 'Conflicting e-way bill numbers in the PDF require review');
  for (const field of ['sellerGstin', 'buyerGstin']) {
    if (!validateGstin(doc[field])) issue(field, 'Missing GSTIN or invalid structure/state/checksum');
    else checks.push(`${field}: structure, state and checksum passed`);
  }
  if (!doc.sellerName || !doc.buyerName) issue('parties', 'Seller/buyer name or role not established');
  if (!doc.totalAmount || minor(doc.totalAmount) <= 0n) issue('totalAmount', 'Missing or non-positive grand total');
  if (!doc.lineItems.length) issue('lineItems', 'No supported line-item layout extracted');
  const lineNumbers = new Set();
  for (const [index, item] of doc.lineItems.entries()) {
    if (lineNumbers.has(item.lineNumber)) issue(`lineItems.${index}`, 'Conflicting repeated line number requires review');
    lineNumbers.add(item.lineNumber);
    if (!item.partNumber || !/\d/.test(item.partNumber) || !item.description || !/^\d{4,8}$/.test(item.hsnSac || '')) issue(`lineItems.${index}`, 'Incomplete item identity/HSN');
    if (!item.quantity || !item.unitPrice || !item.taxableAmount) issue(`lineItems.${index}`, 'Missing quantity/rate/taxable value');
    else if (item.priceUnit && item.priceUnit !== '1.000000') issue(`lineItems.${index}`, 'Non-unit price basis requires review');
    else {
      if (minor(item.taxableAmount) < 0n || productMinor(item.quantity, '1') <= 0n || productMinor(item.unitPrice, '1') < 0n) issue(`lineItems.${index}`, 'Negative value or non-positive quantity');
      const delta = productMinor(item.quantity, item.unitPrice) - minor(item.taxableAmount);
      if (delta < -1n || delta > 1n) issue(`lineItems.${index}`, 'Quantity × unit price does not reconcile with taxable value');
      else checks.push(`lineItems.${index}: quantity × rate reconciled within one paisa`);
    }
    for (const tax of ['cgst','sgst','igst']) {
      if (item[tax + 'Rate'] != null && item[tax] != null && item.taxableAmount != null) {
        const difference = taxMinor(item.taxableAmount, item[tax + 'Rate']) - minor(item[tax]);
        if (difference < -1n || difference > 1n) issue(`lineItems.${index}.${tax}`, 'Tax rate does not reconcile with tax amount');
        else checks.push(`lineItems.${index}.${tax}: taxable value × tax rate reconciled within one paisa`);
      }
    }
  }
  for (const field of ['taxableAmount', 'cgst', 'sgst', 'igst']) {
    if (doc[field] == null || doc.lineItems.some(i => i[field] == null)) issue(field, 'Incomplete monetary components');
    else if (sum(doc.lineItems.map(i => i[field])) !== minor(doc[field])) issue(field, 'Line items do not reconcile with header');
    else checks.push(`${field}: line-item sum reconciled`);
  }
  if (doc.totalAmount && ['taxableAmount','cgst','sgst','igst'].every(k => doc[k] != null)) {
    if (sum([doc.taxableAmount, doc.cgst, doc.sgst, doc.igst]) !== minor(doc.totalAmount)) issue('totalAmount', 'Taxable value plus taxes does not equal grand total; review discounts/rounding/charges');
    else checks.push('Grand total equals taxable value plus CGST/SGST/IGST');
  }
  return { status: issues.length ? 'NEEDS_REVIEW' : 'VALIDATED', issues, checks };
}
module.exports = { validateInvoice, validDate };
