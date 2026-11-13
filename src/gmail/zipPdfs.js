const yauzl = require('yauzl');
const { crc32 } = require('node:zlib');

const ZIP_LIMITS = { archiveBytes: 50*1024*1024, pdfBytes: 25*1024*1024, totalBytes: 200*1024*1024, entries: 1000, pdfs: 200 };

function withoutZeroPadding(bytes) {
  // Some invoice exporters append NUL padding after the complete ZIP footer.
  // Only accept a single-disk footer whose central directory ends exactly here.
  for (let offset=bytes.length-22; offset>=Math.max(0,bytes.length-65557); offset--) {
    if (bytes.readUInt32LE(offset)!==0x06054b50) continue;
    const end=offset+22+bytes.readUInt16LE(offset+20);
    if (end>=bytes.length || bytes.readUInt16LE(offset+4)!==0 || bytes.readUInt16LE(offset+6)!==0) continue;
    if (bytes.readUInt16LE(offset+8)!==bytes.readUInt16LE(offset+10)) continue;
    if (bytes.readUInt32LE(offset+16)+bytes.readUInt32LE(offset+12)!==offset) continue;
    if (bytes.subarray(end).every(value=>value===0)) return bytes.subarray(0,end);
  }
  return null;
}

async function openZip(bytes) {
  const options={lazyEntries:true,validateEntrySizes:true};
  try { return await yauzl.fromBufferPromise(bytes,options); }
  catch (error) {
    if (!/^Invalid comment length\./.test(error.message)) throw error;
    const trimmed=withoutZeroPadding(bytes);
    if (!trimmed) throw error;
    return yauzl.fromBufferPromise(trimmed,options);
  }
}

async function* zipPdfs(bytes, limits = ZIP_LIMITS) {
  if (bytes.length > limits.archiveBytes) throw Error('ZIP attachment exceeds the 50 MB archive limit');
  const zip = await openZip(bytes);
  let index = 0, count = 0, total = 0;
  try {
    if (zip.entryCount > limits.entries) throw Error('ZIP contains too many entries');
    for await (const entry of zip.eachEntry()) {
      const entryIndex = index++;
      if (/\/$/.test(entry.fileName) || !/\.pdf$/i.test(entry.fileName)) continue;
      if (++count > limits.pdfs) throw Error('ZIP contains too many PDFs');
      if ((entry.generalPurposeBitFlag & 1) !== 0) throw Error('Password-protected ZIP PDFs are not supported');
      if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw Error('ZIP PDF symlinks are not supported');
      if (entry.uncompressedSize > limits.pdfBytes || total + entry.uncompressedSize > limits.totalBytes) throw Error('ZIP expanded PDF size limit exceeded');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > limits.pdfBytes || total + size > limits.totalBytes) throw Error('ZIP expanded PDF size limit exceeded');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (crc32(data) !== entry.crc32) throw Error('ZIP PDF checksum does not match: ' + entry.fileName);
      total += size;
      yield { filename: entry.fileName.split('/').pop(), entryName: entry.fileName, entryIndex, bytes: data };
    }
  } finally { zip.close(); }
}

module.exports = { zipPdfs, ZIP_LIMITS };
