const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function attachmentFilename(value) {
  let name = String(value || '').split(/[\\/]/).pop()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  if (!name || /^\.+$/.test(name)) name = 'attachment.pdf';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  if (name.length > 240) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 240 - ext.length).replace(/[\uD800-\uDBFF]$/, '') + ext;
  }
  return name;
}
function folderKey(value) {
  const raw = String(value);
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(raw) ? raw
    : 'id-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}
function attachmentPath(dataDir, messageId, partKey, filename) {
  return path.resolve(dataDir, 'pdfs', folderKey(messageId), folderKey(partKey), attachmentFilename(filename));
}
function writeOriginal(file, bytes) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  try { fs.writeFileSync(file, bytes, {flag:'wx'}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.readFileSync(file).equals(bytes)) throw Error('Existing PDF differs from attachment; refusing to overwrite it');
  }
}
module.exports = {attachmentFilename, folderKey, attachmentPath, writeOriginal};
