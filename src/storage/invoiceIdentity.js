function normalizeInvoiceNumber(value) {
  if (typeof value !== 'string') return null;
  const number = value.trim().toUpperCase();
  return number.length <= 40 && /\d/.test(number) && /^[A-Z0-9][A-Z0-9/_.()-]*$/.test(number) ? number : null;
}
function invoiceIdentity(number, documentType) {
  return documentType === 'TAX_INVOICE' ? normalizeInvoiceNumber(number) : null;
}
module.exports = { normalizeInvoiceNumber, invoiceIdentity };
