const yauzl = require('yauzl');
const { crc32 } = require('node:zlib');

const ZIP_LIMITS = { archiveBytes: 50*1024*1024, pdfBytes: 25*1024*1024, totalBytes: 200*1024*1024, entries: 1000, pdfs: 200 };

async function* zipPdfs(bytes, limits = ZIP_LIMITS) {
  if (bytes.length > limits.archiveBytes) throw Error('ZIP attachment exceeds the 50 MB archive limit');
  const zip = await yauzl.fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true });
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
