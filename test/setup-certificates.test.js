const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {checkCertificates}=require('../scripts/check-certificates');
const {collectStatus}=require('../scripts/setup');
const root=path.resolve(__dirname,'..');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-cert-check-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const manifest=require('../certificates/approved-manifest.json');
  for(const file of ['approved-manifest.json',...manifest.certificates.map(c=>c.file)]) {
    const dest=path.join(dir,'certificates',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,'certificates',file),dest);
  }
  return dir;
}
test('offline setup validates all bundled vendor chains and detects missing or changed CA files',t=>{
  const dir=fixture(t);
  assert.equal(checkCertificates(dir).ready,true);
  const file=path.join(dir,'certificates','intermediates','SignXCA2022.cer');
  const bytes=fs.readFileSync(file);
  fs.writeFileSync(file,Buffer.from('changed certificate'));
  assert.equal(checkCertificates(dir).ready,false);
  assert.match(checkCertificates(dir).issues.join('\n'),/Fingerprint/);
  fs.writeFileSync(file,bytes);fs.unlinkSync(file);
  assert.equal(checkCertificates(dir).ready,false);
  assert.equal(fs.existsSync(path.join(dir,'data')),false);
});
test('offline setup rejects expired bundles and reports a custom trust directory missing the vendor chain',t=>{
  const dir=fixture(t);
  assert.equal(checkCertificates(dir,{now:Date.parse('2045-01-01')}).ready,false);
  assert.equal(checkCertificates(dir,{trustDir:path.join(dir,'custom','trusted-roots')}).ready,false);
});
test('setup reads explicit legacy policy from local env without changing it',t=>{
  const dir=fixture(t);const envFile=path.join(dir,'.env');
  fs.writeFileSync(envFile,'SIGNATURE_ALLOW_LEGACY_SHA1=true\n');
  const options={env:{},run:()=>({ok:false,text:''}),platform:'win32'};
  assert.equal(collectStatus(dir,options).legacySha1Enabled,true);
  assert.equal(collectStatus(dir,{...options,env:{SIGNATURE_ALLOW_LEGACY_SHA1:'false'}}).legacySha1Enabled,false);
  assert.equal(fs.readFileSync(envFile,'utf8'),'SIGNATURE_ALLOW_LEGACY_SHA1=true\n');
  assert.equal(fs.existsSync(path.join(dir,'data')),false);
});

test('Adobe setup checks probe the selected engine without requiring Sumatra or opening Reader',t=>{
  const dir=fixture(t);const calls=[];
  const status=collectStatus(dir,{env:{PRINT_ENGINE:'adobe'},platform:'win32',run:(command,args)=>{
    calls.push(args);
    if(command==='powershell.exe'&&args.includes('-Check'))return {ok:true,text:JSON.stringify({ready:true,executable:'C:\\Adobe\\Acrobat.exe',printer:'Physical printer'})};
    return {ok:false,text:''};
  }});
  assert.equal(status.printEngine,'adobe');assert.equal(status.adobe.ready,true);assert.equal(status.sumatra,false);
  assert.ok(calls.every(args=>!args.includes('-JobPath')));
  assert.equal(fs.existsSync(path.join(dir,'data')),false);
});
