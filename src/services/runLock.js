const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

function acquireRunLock(dataDir) {
  fs.mkdirSync(dataDir,{recursive:true});
  const file=path.join(dataDir,'extractor.lock'),token=crypto.randomUUID();
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const fd=fs.openSync(file,'wx');
      try {fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));} finally {fs.closeSync(fd);}
      return ()=>{if(fs.existsSync(file) && JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.unlinkSync(file);};
    } catch(e) {
      if(e.code!=='EEXIST')throw e;
      let previous;
      try {previous=JSON.parse(fs.readFileSync(file,'utf8'));} catch {throw Error('Extractor lock is unreadable. Check that no extractor is running before removing data/extractor.lock.');}
      if(!Number.isInteger(previous.pid) || previous.pid<=0)throw Error('Invalid extractor lock. Check data/extractor.lock.');
      try {process.kill(previous.pid,0);} catch(error) {if(error.code==='ESRCH'){fs.unlinkSync(file);continue;}throw error;}
      throw Error('An invoice extraction or setup run is already active. Wait for its window to finish.');
    }
  }
  throw Error('Could not acquire the extractor run lock.');
}
module.exports={acquireRunLock};
