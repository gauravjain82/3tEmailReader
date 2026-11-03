// This MAHLE template's embedded font maps printable Latin glyphs into the
// Unicode private-use area in reverse byte order. Gate decoding on its known
// document labels so unrelated symbol fonts and other scripts remain unchanged.
function normalizePdfText(text) {
  const privateChars=(text.match(/[\uF0A1-\uF0FF\uF020]/g)||[]).length;
  if (privateChars<50 || privateChars/Math.max(1,text.replace(/\s/g,'').length)<0.5) return text;
  const decoded=text.replace(/[\uF0A1-\uF0FF]/g,c=>String.fromCharCode(0x120-(c.charCodeAt(0)&255))).replace(/\uF020/g,' ');
  if (!/MAHLE ENGINE COMPONENTS INDIA/i.test(decoded) || !/TAX\s+INVOICE/i.test(decoded) || !/Invoice Serial Number/i.test(decoded) || !/Our GSTIN Number/i.test(decoded)) return text;
  return decoded;
}
module.exports = { normalizePdfText };
