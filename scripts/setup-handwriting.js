// Optional local handwriting model; kept separate from the signature verifier.
const path=require('path');
const {spawnSync}=require('child_process');
const {findPython312,ensurePythonEnvironment}=require('./python-runtime');
const {acquireRunLock}=require('../src/services/runLock');
const root=path.resolve(__dirname,'..');
function execute(command,args,projectRoot=root){
  const result=spawnSync(command,args,{cwd:projectRoot,stdio:'inherit',windowsHide:true});
  if(result.error||result.status!==0)throw Error('Handwriting setup failed. Review the command output above.');
}
function setupHandwriting(projectRoot=root,{pythonCommand=findPython312(projectRoot),run,exec=execute}={}){
  const environment=ensurePythonEnvironment(projectRoot,'.handwriting-venv',pythonCommand,{run,execute:exec});
  const executable=environment.executable;
  console.log('Handwriting Python:',environment.version,'64-bit (same selected runtime as the signature verifier)');
  exec(executable,['-m','pip','install','--upgrade','pip'],projectRoot);
  exec(executable,['-m','pip','install','--only-binary=:all:','--index-url','https://download.pytorch.org/whl/cpu','torch==2.9.1'],projectRoot);
  exec(executable,['-m','pip','install','--only-binary=:all:','-r','requirements-handwriting.txt'],projectRoot);
  exec(executable,['scripts/handwriting_worker.py','--download'],projectRoot);
  console.log('Local handwriting model ready. Run Parse Rejection Invoices.cmd or Test Handwriting OCR.cmd.');
}
function main(){
  if(process.platform!=='win32')throw Error('This installer is for Windows with 64-bit Python 3.12.');
  const base=path.join(root,'rejections'),release=acquireRunLock(base);
  try{
    setupHandwriting(root);
  }finally{release();}
}
if(require.main===module)try{main();}catch(error){console.error(error.message);process.exitCode=1;}
module.exports={setupHandwriting};
