const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {supportedNode,supportedPython,ensureLocalFiles,updateSenders,collectStatus,findPython312,repairSignatures}=require('../scripts/setup');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-setup-test-'));
  t.after(()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-setup-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  fs.writeFileSync(path.join(dir,'.env.example'),'GMAIL_QUERY=in:inbox has:attachment filename:pdf\n');
  fs.writeFileSync(path.join(dir,'config.example.json'),JSON.stringify({allowedSenders:['billing@example.com'],firstRunAfter:null}));
  return dir;
}

test('signature repair selects only 64-bit Python 3.12, including when PATH points at 3.15',()=>{
  const executable=path.resolve('python312-test','python.exe');
  const result=findPython312(process.cwd(),{env:{},run:command=>({ok:true,text:JSON.stringify({executable,version:command==='py'?[3,12]:[3,15],bits:64})})});
  assert.equal(result,executable);
  for(const info of [{version:[3,15],bits:64},{version:[3,12],bits:32}]) {
    assert.throws(()=>findPython312(process.cwd(),{env:{},run:()=>({ok:true,text:JSON.stringify({...info,executable})})}),/64-bit Python 3.12 was not found/);
  }
});

test('signature repair preserves old environment and data, and does not move anything when Python is missing',t=>{
  const dir=fixture(t);ensureLocalFiles(dir);
  const environment=path.join(dir,'.signature-venv');fs.mkdirSync(environment);fs.writeFileSync(path.join(environment,'old-marker'),'old verifier');
  fs.mkdirSync(path.join(dir,'data'));fs.writeFileSync(path.join(dir,'data','invoice.pdf'),'original invoice');
  const settings=fs.readFileSync(path.join(dir,'.env'),'utf8');
  assert.throws(()=>repairSignatures(dir,{find:()=>{throw Error('Python missing');}}),/Python missing/);
  assert.equal(fs.readFileSync(path.join(environment,'old-marker'),'utf8'),'old verifier');
  const pythonCommand=path.resolve('python312-test','python.exe');
  repairSignatures(dir,{find:()=>pythonCommand,install:(projectRoot,options)=>{
    assert.equal(projectRoot,dir);assert.equal(options.pythonCommand,pythonCommand);
    assert.equal(fs.existsSync(environment),false);fs.mkdirSync(environment);fs.writeFileSync(path.join(environment,'new-marker'),'new verifier');
  }});
  const backups=fs.readdirSync(path.join(dir,'data','backups'));assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(dir,'data','backups',backups[0],'old-marker'),'utf8'),'old verifier');
  assert.equal(fs.readFileSync(path.join(dir,'data','invoice.pdf'),'utf8'),'original invoice');
  assert.equal(fs.readFileSync(path.join(dir,'.env'),'utf8'),settings);
});
test('setup accepts supported runtimes and identifies unsupported/missing versions',()=>{
  for(const v of ['v22.16.0','v24.22.1'])assert.equal(supportedNode(v),true);
  for(const v of ['v20.19.0','v22.0.0','v26.0.0','missing'])assert.equal(supportedNode(v),false);
  assert.equal(supportedPython('Python 3.12.10'),true);assert.equal(supportedPython('Python 3.9.0'),false);
});
test('new local settings contain no active example senders and subsequent setup preserves private files',t=>{
  const dir=fixture(t);assert.deepEqual(ensureLocalFiles(dir),['.env','config.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'config.json'))).allowedSenders,[]);
  const env='PRIVATE_SETTING=do-not-overwrite\n',config=JSON.stringify({allowedSenders:['actual@company.test'],firstRunAfter:null});
  fs.writeFileSync(path.join(dir,'.env'),env);fs.writeFileSync(path.join(dir,'config.json'),config);
  fs.mkdirSync(path.join(dir,'data'));fs.writeFileSync(path.join(dir,'data','keep.pdf'),'invoice bytes');
  assert.deepEqual(ensureLocalFiles(dir),[]);assert.equal(fs.readFileSync(path.join(dir,'.env'),'utf8'),env);
  assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),config);assert.equal(fs.readFileSync(path.join(dir,'data','keep.pdf'),'utf8'),'invoice bytes');
});
test('sender updates are validated before writing and preserve the prior configuration in a private backup',t=>{
  const dir=fixture(t);ensureLocalFiles(dir);const file=path.join(dir,'config.json');const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>updateSenders(dir,'not-an-email'));assert.equal(fs.readFileSync(file,'utf8'),before);
  updateSenders(dir,'first@company.test,second@company.test');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).allowedSenders,['first@company.test','second@company.test']);
  const backups=fs.readdirSync(path.join(dir,'data','backups'));assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(dir,'data','backups',backups[0],'config.json'),'utf8'),before);
});
test('read-only diagnostics distinguish configured extraction from a virtual printer and never disclose credentials',t=>{
  const dir=fixture(t);fs.writeFileSync(path.join(dir,'credentials.json'),JSON.stringify({installed:{client_id:'private-client-value',client_secret:'private-secret-value'}}));
  fs.writeFileSync(path.join(dir,'token.json'),JSON.stringify({refresh_token:'private-token-value'}));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({allowedSenders:['actual@company.test'],firstRunAfter:null}));
  const calls=[];const run=(command,args)=>{calls.push([command,args]);return command==='python'?{ok:true,text:'Python 3.12.10'}:command==='powershell.exe'?{ok:true,text:JSON.stringify({name:'Export to WPS PDF',valid:true})}:{ok:true,text:''};};
  const status=collectStatus(dir,{run,env:{},version:'v24.22.1',platform:'win32'});
  assert.equal(status.extractionReady,true);assert.equal(status.printer.physical,false);assert.equal(status.printingPrerequisitesReady,false);
  assert.ok(!JSON.stringify(status).includes('private-'));assert.ok(calls.every(([,args])=>!args.includes('ci') && !args.includes('install')));
  assert.equal(fs.existsSync(path.join(dir,'data')),false);assert.equal(fs.existsSync(path.join(dir,'.env')),false);
});
