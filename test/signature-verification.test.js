const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {spawnSync}=require('child_process');
const {verifyPdfSignature}=require('../src/services/signatureVerificationService');
const {printOriginalInvoices}=require('../src/services/printService');
const {openStore}=require('../src/storage/store');
const {processText}=require('../src/services/invoiceProcessingService');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-signature-node-'));
  const store=openStore(dir),file=path.join(dir,'original.pdf');fs.writeFileSync(file,'%PDF-1.7 test-only bytes');
  const hash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const row=store.save({gmail_id:'m1',attachment_key:'a',filename:'original.pdf',sha256:hash,pdf_path:file},processText('Tax Invoice\nInvoice No: SIG001'));
  const item={id:row.id,invoiceNumber:'SIG001',pdfPath:file,sha256:hash,sourcePdfPath:file,sourceSha256:hash,pages:[2]};
  t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-signature-node-'));fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,file,hash,item};
}
function valid(hash) {return {schemaVersion:1,verifier:'pyHanko-0.33.0',status:'VALID',sha256:hash,reason:'All test checks passed',checkedAt:new Date().toISOString(),signatures:[{status:'VALID',intact:true,cryptographicallyValid:true,trusted:true,coverage:'ENTIRE_FILE'}]};}

test('signature helper accepts only complete verified results for the unchanged source',async t=>{
  const {file,hash}=fixture(t);let options;
  const report=await verifyPdfSignature(file,hash,{python:process.execPath,run:async(...args)=>{options=args;return {stdout:JSON.stringify(valid(hash))};}});
  assert.equal(report.status,'VALID');assert.equal(options[2].windowsHide,true);assert.equal(options[2].shell,undefined);
  assert.ok(options[1].includes(path.resolve(file)));
});

test('legacy SHA-1 is forwarded only for explicit opt-in and still blocks untrusted signatures',async t=>{
  const {file,hash,dir,store,item}=fixture(t);
  for(const enabled of [false,true,'true']) {
    let args;
    const report=await verifyPdfSignature(file,hash,{python:process.execPath,allowLegacySha1:enabled,run:async(_command,argv)=>{
      args=argv;return {stdout:JSON.stringify({schemaVersion:1,status:'UNKNOWN',reason:'Missing trusted issuer',signatures:[]})};
    }});
    assert.equal(args.includes('--allow-legacy-sha1'),enabled===true);
    assert.equal(report.status,'UNKNOWN');
  }

});
test('missing helper, changed source, malformed output and incomplete approval all block verification',async t=>{
  const {file,hash,dir}=fixture(t);
  assert.equal((await verifyPdfSignature(file,'wrong')).status,'INVALID');
  assert.equal((await verifyPdfSignature(file,hash,{python:path.join(dir,'missing-python.exe')})).status,'ERROR');
  for(const output of ['not JSON',JSON.stringify({schemaVersion:1,status:'VALID',signatures:[]}),JSON.stringify({...valid(hash),sha256:'different'})]) {
    assert.equal((await verifyPdfSignature(file,hash,{python:process.execPath,run:async()=>({stdout:output})})).status,'ERROR');
  }
});
test('Sumatra prints unchanged source bytes without a signature verification step',async t=>{
  const {store,item,hash,file}=fixture(t);let called=false;
  const result=await printOriginalInvoices(store,[item],{platform:'win32',findExecutable:()=> 'printer.exe',verifySignature:()=>assert.fail('Printing must not validate signatures'),run:async(executable,args)=>{
    called=true;assert.ok(args.includes('2,1x,simplex,fit'));assert.ok(args.includes('-print-to-default'));
    assert.deepEqual(fs.readFileSync(args.at(-1)),fs.readFileSync(file));
    assert.equal(store.db.prepare('SELECT count(*) n FROM signature_checks').get().n,0);
  }});
  assert.equal(called,true);assert.equal(result.submitted.length,1);
});
test('real offline cryptographic tests validate, tamper, trust, revocation and unsigned cases',t=>{
  const python=process.env.SIGNATURE_PYTHON || path.resolve('.signature-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(!fs.existsSync(python))return t.skip('Run Setup Signature Verification.cmd to install the cryptographic test dependency');
  const result=spawnSync(python,['test/signature_crypto_checks.py'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr || result.error?.message);assert.match(result.stderr,/Ran 23 tests/);
});
