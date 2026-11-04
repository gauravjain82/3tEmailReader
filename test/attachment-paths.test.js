const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {attachmentFilename, attachmentPath, writeOriginal,writeNamedFile} = require('../src/storage/attachmentPaths');

test('original attachment names survive while unsafe Windows names are contained', () => {
  assert.equal(attachmentFilename('6202602146_1_SIGNED.pdf'), '6202602146_1_SIGNED.pdf');
  assert.equal(attachmentFilename('Invoice हिन्दी (41).PDF'), 'Invoice हिन्दी (41).PDF');
  assert.equal(attachmentFilename('../../invoice.pdf'), 'invoice.pdf');
  assert.equal(attachmentFilename('C:\\temp\\invoice.pdf'), 'invoice.pdf');
  assert.equal(attachmentFilename('CON.pdf'), '_CON.pdf');
  assert.equal(attachmentFilename('a:b?.pdf. '), 'a_b_.pdf');
  const root = path.resolve('data');
  assert.ok(attachmentPath(root, '../../escape', '..', '../../invoice.pdf').startsWith(path.join(root,'pdfs')+path.sep));
});

test('same-named PDFs share one folder with numbered collisions and unchanged bytes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-name-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const folder=path.join(dir,'pdfs');
  const locations = [0,1,2].map(i=>writeNamedFile(folder,'original invoice.pdf',Buffer.from('signed PDF bytes '+i)));
  assert.equal(new Set(locations).size,3);
  assert.deepEqual(locations.map(file=>path.basename(file)),['original invoice.pdf','original invoice (2).pdf','original invoice (3).pdf']);
  assert.equal(new Set(locations.map(file=>path.dirname(file))).size,1);
  locations.forEach((file,i) => {
    const bytes = Buffer.from('signed PDF bytes '+i);
    writeOriginal(file,bytes); writeOriginal(file,bytes);
    assert.equal(writeNamedFile(folder,'original invoice.pdf',bytes),file);
    assert.deepEqual(fs.readFileSync(file),bytes);
    assert.throws(() => writeOriginal(file,Buffer.from('changed')), /refusing to overwrite/);
    assert.deepEqual(fs.readFileSync(file),bytes);
  });
  assert.equal(fs.readdirSync(folder).length,3);
});
