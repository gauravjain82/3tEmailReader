// Shared Python selection for both signature verification and handwriting OCR.
const fs=require('fs');
const path=require('path');
const {spawnSync}=require('child_process');
const INSPECT="import sys,struct,json; print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3]),'bits':struct.calcsize('P')*8}))";
function probe(command,args,projectRoot){
  const r=spawnSync(command,args,{cwd:projectRoot,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:128*1024});
  return {ok:r.status===0,text:((r.stdout||'')+'\n'+(r.stderr||'')).trim()};
}
function supportedRuntime(info){return !!info&&info.version?.[0]===3&&info.version?.[1]===12&&info.bits===64;}
function inspectPython(command,projectRoot,{run=probe}={}){
  const result=run(command,['-c',INSPECT],projectRoot);
  if(result.ok)try{const info=JSON.parse(result.text);if(Array.isArray(info.version)&&Number.isInteger(info.bits))return info;}catch{}
  return null;
}
function findPython312(projectRoot,{run=probe,env=process.env}={}){
  const candidates=[];
  if(env.LOCALAPPDATA)candidates.push([path.join(env.LOCALAPPDATA,'Programs','Python','Python312','python.exe'),[]]);
  if(env.ProgramFiles)candidates.push([path.join(env.ProgramFiles,'Python312','python.exe'),[]]);
  candidates.push(['py',['-3.12']],['python',[]]);
  for(const [command,prefix] of candidates){
    const result=run(command,[...prefix,'-c',INSPECT],projectRoot);
    if(result.ok)try{
      const info=JSON.parse(result.text);
      if(supportedRuntime(info)&&typeof info.executable==='string'&&path.isAbsolute(info.executable))return info.executable;
    }catch{}
  }
  throw Error('64-bit Python 3.12 was not found. Install Python 3.12.10 (64-bit) from https://www.python.org/downloads/release/python-31210/ or use py install 3.12, then rerun setup. Existing environments were not changed.');
}
function ensurePythonEnvironment(projectRoot,name,pythonCommand,{run=probe,execute}={}){
  if(!['.signature-venv','.handwriting-venv'].includes(name)||typeof execute!=='function')throw Error('Invalid Python environment setup request.');
  const base=inspectPython(pythonCommand,projectRoot,{run});
  if(!supportedRuntime(base)||base.version.length!==3)throw Error('Both features require the same 64-bit Python 3.12 runtime. See SETUP.md.');
  const environment=path.resolve(projectRoot,name),executable=path.join(environment,'Scripts','python.exe');
  const old=fs.existsSync(executable)?inspectPython(executable,projectRoot,{run}):null;
  if(supportedRuntime(old)&&old.version.join('.')===base.version.join('.'))return {executable,version:base.version.join('.'),rebuilt:false};
  if(fs.existsSync(environment)){
    const backups=path.resolve(projectRoot,'data','backups');
    const backup=path.join(backups,`${name.slice(1)}-${Date.now()}-${require('crypto').randomUUID()}`);
    if(path.dirname(environment)!==path.resolve(projectRoot)||!backup.startsWith(backups+path.sep))throw Error('Invalid environment backup path.');
    fs.mkdirSync(backups,{recursive:true});fs.renameSync(environment,backup);
    console.log('Previous Python environment preserved at:',backup);
  }
  execute(pythonCommand,['-m','venv',environment],projectRoot);
  const created=inspectPython(executable,projectRoot,{run});
  if(!supportedRuntime(created)||created.version.join('.')!==base.version.join('.'))throw Error('Created environment does not match the selected Python version. See SETUP.md.');
  return {executable,version:base.version.join('.'),rebuilt:true};
}
module.exports={findPython312,inspectPython,supportedRuntime,ensurePythonEnvironment};
