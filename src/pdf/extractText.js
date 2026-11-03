const fs = require('fs');
const { PDFParse } = require('pdf-parse');
const { normalizePdfText } = require('./normalizePdfText');
async function extractText(source) {
  const bytes = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('Attachment is not a valid PDF');
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    const text = normalizePdfText(result.text || '');
    if (text.trim().length < 30) throw Error('No extractable text (scanned PDF or image-only). OCR required.');
    return text;
  } finally { await parser.destroy(); }
}
module.exports = { extractText };
