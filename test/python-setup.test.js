const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const {ensurePythonEnvironment}=require('../scripts/python-runtime');
const {setupSignatures,collectStatus}=require('../scripts/setup');
const {setupHandwriting}=require('../scripts/setup-handwriting');
const spec=require('../scripts/handwriting-model.json');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-python-setup-'));
  t.after(()=>{assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('invoice-python-setup-'));fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}
function fakeRuntime(dir){
  const base=path.join(dir,'base-python.exe'),versions=new Map([[base,[3,12,10]]]),calls=[];
  const run=(command,args)=>({ok:true,text:args[1]?.includes('sys.version_info')?JSON.stringify({executable:command,version:versions.get(command)||[3,15,2],bits:64}):''});
  const exec=(command,args)=>{
    calls.push({command,args});
    if(args[0]==='-m'&&args[1]==='venv'){
      const executable=path.join(args[2],'Scripts','python.exe');fs.mkdirSync(path.dirname(executable),{recursive:true});fs.writeFileSync(executable,'test placeholder');versions.set(executable,versions.get(command));
    }
  };
  return {base,versions,calls,run,exec};
}
test('both installers use the same selected Python patch version while keeping separate environments',t=>{
  const dir=fixture(t),runtime=fakeRuntime(dir),options={pythonCommand:runtime.base,run:runtime.run,exec:runtime.exec};
  setupSignatures(dir,options);setupHandwriting(dir,options);
  const creations=runtime.calls.filter(c=>c.args[1]==='venv');assert.equal(creations.length,2);
  assert.ok(creations.every(c=>c.command===runtime.base));
  for(const name of ['.signature-venv','.handwriting-venv'])assert.deepEqual(runtime.versions.get(path.join(dir,name,'Scripts','python.exe')),[3,12,10]);
  assert.ok(runtime.calls.some(c=>c.args.includes('scripts/handwriting_worker.py')&&c.args.includes('--download')));
});
test('version mismatch is backed up before rebuilding, and an unsupported base changes nothing',t=>{
  const dir=fixture(t),runtime=fakeRuntime(dir),name='.handwriting-venv',executable=path.join(dir,name,'Scripts','python.exe');
  fs.mkdirSync(path.dirname(executable),{recursive:true});fs.writeFileSync(executable,'old Python');runtime.versions.set(executable,[3,12,9]);
  fs.writeFileSync(path.join(dir,'keep.csv'),'saved invoice data');
  runtime.versions.set(runtime.base,[3,15,2]);
  assert.throws(()=>ensurePythonEnvironment(dir,name,runtime.base,{run:runtime.run,execute:runtime.exec}),/64-bit Python 3.12/);
  assert.equal(fs.readFileSync(executable,'utf8'),'old Python');assert.equal(runtime.calls.length,0);
  runtime.versions.set(runtime.base,[3,12,10]);
  const result=ensurePythonEnvironment(dir,name,runtime.base,{run:runtime.run,execute:runtime.exec});
  assert.equal(result.version,'3.12.10');assert.equal(result.rebuilt,true);
  const backups=fs.readdirSync(path.join(dir,'data','backups'));assert.equal(backups.length,1);
  assert.equal(fs.readFileSync(path.join(dir,'data','backups',backups[0],'Scripts','python.exe'),'utf8'),'old Python');
  assert.equal(fs.readFileSync(path.join(dir,'keep.csv'),'utf8'),'saved invoice data');
  runtime.calls.length=0;assert.equal(ensurePythonEnvironment(dir,name,runtime.base,{run:runtime.run,execute:runtime.exec}).rebuilt,false);assert.equal(runtime.calls.length,0);
});
test('read-only checks detect model completeness without requiring signature-Python alignment',t=>{
  const dir=fixture(t),runtime=fakeRuntime(dir);
  for(const name of ['.signature-venv','.handwriting-venv'])runtime.exec(runtime.base,['-m','venv',path.join(dir,name)]);
  const model=path.join(dir,'rejections','models','trocr-base-handwritten');fs.mkdirSync(model,{recursive:true});
  fs.writeFileSync(path.join(model,'source.json'),JSON.stringify({model:spec.id,revision:spec.revision}));
  for(const name of spec.requiredFiles)fs.writeFileSync(path.join(model,name),'model test placeholder');
  runtime.calls.length=0;
  const run=(command,args)=>{assert.ok(!args.includes('install')&&!args.includes('--download')&&!args.includes('venv'));return runtime.run(command,args);};
  let status=collectStatus(dir,{run,env:{},platform:'win32'});
  assert.equal(status.pythonVersionsMatch,true);assert.equal(status.handwritingModel,true);assert.equal(status.localHandwritingReady,true);
  const executable=path.join(dir,'.handwriting-venv','Scripts','python.exe');runtime.versions.set(executable,[3,12,9]);
  status=collectStatus(dir,{run,env:{},platform:'win32'});assert.equal(status.pythonVersionsMatch,false);assert.equal(status.localHandwritingReady,true);
  runtime.versions.set(executable,[3,12,10]);fs.unlinkSync(path.join(model,'model.safetensors'));
  status=collectStatus(dir,{run,env:{},platform:'win32'});assert.equal(status.handwritingModel,false);assert.equal(status.localHandwritingReady,false);
  assert.equal(runtime.calls.length,0);
});
