const TYPES = ['TAX_INVOICE', 'BIN_TAG', 'COLOUR_CODE_DOCUMENT', 'OTHER', 'UNKNOWN'];
function detectDocumentType(text) {
  if (/\btax\s+invoice\b/i.test(text)) return { type: 'TAX_INVOICE', basis: 'Tax invoice heading' };
  if (/\bbin\s*(?:no\.?|tag)\b/i.test(text) && /qty\s*\/\s*bin|schedule\s+no/i.test(text))
    return { type: 'BIN_TAG', basis: 'Bin number and bin quantity/schedule labels' };
  if (/colou?r\s*code/i.test(text) || (/consignment\s+no/i.test(text) && /unload\s+(?:cards|no)/i.test(text)))
    return { type: 'COLOUR_CODE_DOCUMENT', basis: 'Colour code or consignment/unload card layout' };
  if (/delivery\s+challan|packing\s+list|credit\s+note/i.test(text)) return { type: 'OTHER', basis: 'Non-invoice document heading' };
  return { type: 'UNKNOWN', basis: 'No supported document indicators' };
}
module.exports = { detectDocumentType, TYPES };
