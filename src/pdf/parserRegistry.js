const { fstInvoiceParser } = require('./parsers/fstInvoiceParser');
const { hubInvoiceParser } = require('./parsers/hubInvoiceParser');
const { genericInvoiceParser } = require('./parsers/genericInvoiceParser');
const { mahleInvoiceParser } = require('./parsers/mahleInvoiceParser');
const { cieInvoiceParser } = require('./parsers/cieInvoiceParser');
const PARSER_VERSION = '2.3.5';
const registry = [
  { name: 'fst', matches: t => /Freudenberg[-\s]NOK|india\.fst\.com/i.test(t), parse: fstInvoiceParser },
  { name: 'hub', matches: t => /Samvardhana Motherson Innovative Solutions/i.test(t) && /Item Code\/ Description\/ Cust\./i.test(t), parse: hubInvoiceParser },
  { name: 'mahle', matches: t => /MAHLE ENGINE COMPONENTS INDIA/i.test(t) && /Invoice Serial Number/i.test(t), parse: mahleInvoiceParser },
  { name: 'cie', matches: t => /Company Name:\s*CIE Automotive India Limited/i.test(t) && /GST Inv\. No\./i.test(t), parse: cieInvoiceParser },
  { name: 'generic', matches: () => true, parse: genericInvoiceParser }
];
function parseInvoice(text) {
  const parser = registry.find(p => p.matches(text));
  return { ...parser.parse(text), parserName: parser.name, parserVersion: PARSER_VERSION };
}
module.exports = { parseInvoice, registry, PARSER_VERSION };
