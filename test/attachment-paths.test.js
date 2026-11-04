const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {attachmentFilename, attachmentPath, writeOriginal} = require('../src/storage/attachmentPaths');

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

test('same-named attachments remain separate and saved bytes cannot be overwritten', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-name-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const locations = [['m1','part-1'],['m1','part-2'],['m2','part-1']]
    .map(([m,p]) => attachmentPath(dir,m,p,'original invoice.pdf'));
  assert.equal(new Set(locations).size,3);
  locations.forEach((file,i) => {
    const bytes = Buffer.from('signed PDF bytes '+i);
    writeOriginal(file,bytes); writeOriginal(file,bytes);
    assert.equal(path.basename(file),'original invoice.pdf');
    assert.deepEqual(fs.readFileSync(file),bytes);
    assert.throws(() => writeOriginal(file,Buffer.from('changed')), /refusing to overwrite/);
    assert.deepEqual(fs.readFileSync(file),bytes);
  });
});
