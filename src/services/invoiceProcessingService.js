const { extractText } = require('../pdf/extractText');
const { detectDocumentType } = require('../pdf/detectDocumentType');
const { parseInvoice, PARSER_VERSION } = require('../pdf/parserRegistry');
const { validateInvoice } = require('../pdf/validators/invoiceValidator');
function processText(text) {
  const classification = detectDocumentType(text);
  const doc = classification.type === 'TAX_INVOICE' || classification.type === 'UNKNOWN'
    ? parseInvoice(text)
    : { parserName: 'classification-only', parserVersion: PARSER_VERSION, lineItems: [], gstins: [], partNumbers: [] };
  Object.assign(doc, { documentType: classification.type, classificationBasis: classification.basis, textExcerpt: text.slice(0,2000) });
  doc.validation = validateInvoice(doc);
  return doc;
}
async function processPdf(source) {
  try { return processText(await extractText(source)); }
  catch (error) {
    return { documentType: 'UNKNOWN', parserName: 'text-extraction', parserVersion: PARSER_VERSION, lineItems: [], gstins: [], partNumbers: [], error: error.message, validation: { status: 'FAILED', issues: [{ field: 'pdf', reason: error.message }], checks: [] } };
  }
}
module.exports = { processPdf, processText };
