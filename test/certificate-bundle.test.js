const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const manifest = require('../certificates/approved-manifest.json');

test('bundled public CA certificates match approved fingerprints and form all three chains', () => {
  assert.equal(manifest.certificates.length,7);
  const certs=manifest.certificates.map(entry => {
    const bytes=fs.readFileSync(path.join(__dirname,'../certificates',entry.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);
    const cert=new crypto.X509Certificate(bytes);
    assert.equal(cert.ca,true);
    assert.ok(Date.parse(cert.validFrom)<=Date.now());
    assert.ok(Date.parse(cert.validTo)>Date.now());
    return cert;
  });
  assert.equal(certs[0].verify(certs[0].publicKey),true);
  for(const [child,parent] of [[1,0],[2,1],[3,0],[4,3],[5,0],[6,5]]) {
    assert.equal(certs[child].checkIssued(certs[parent]),true);
    assert.equal(certs[child].verify(certs[parent].publicKey),true);
  }
});
