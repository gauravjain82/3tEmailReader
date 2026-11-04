// Offline setup diagnostics only; this does not verify any invoice signature.
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

function checkCertificates(projectRoot,{trustDir=path.join(projectRoot,'certificates','trusted-roots'),now=Date.now()}={}) {
  const issues=[];
  const certs=[];
  try {
    const manifest=JSON.parse(fs.readFileSync(path.join(projectRoot,'certificates','approved-manifest.json'),'utf8'));
    if(!Array.isArray(manifest.certificates)||manifest.certificates.length!==7)throw Error('Expected seven bundled public CA certificates');
    const seen=new Set();
    for(const entry of manifest.certificates) {
      try {
        if(!/^(trusted-roots|intermediates)\/[A-Za-z0-9._-]+\.cer$/.test(entry.file)||seen.has(entry.file))throw Error('Invalid or repeated manifest path');
        seen.add(entry.file);
        const role=entry.file.startsWith('trusted-roots/')?'trust-anchor':'intermediate';
        if(entry.role!==role)throw Error('Incorrect CA role');
        const bytes=fs.readFileSync(path.join(projectRoot,'certificates',entry.file));
        if(crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('Fingerprint differs from approved manifest');
        const cert=new crypto.X509Certificate(bytes);
        if(!cert.ca)throw Error('Certificate is not a CA');
        if(Date.parse(cert.validFrom)>now||Date.parse(cert.validTo)<=now)throw Error('CA certificate is expired or not yet valid');
        const activePath=path.join(role==='trust-anchor'?path.resolve(trustDir):path.join(path.dirname(path.resolve(trustDir)),'intermediates'),path.basename(entry.file));
        const active=fs.readFileSync(activePath);
        if(!active.equals(bytes))throw Error('Configured trust folder does not contain the approved certificate');
        certs.push({cert,role,file:entry.file});
      } catch(error) {issues.push(`${entry.file}: ${error.message}`);}
    }
    const roots=certs.filter(c=>c.role==='trust-anchor');
    if(roots.length!==1)issues.push('Expected one bundled trust anchor');
    function reachesRoot(item,visited=new Set()) {
      if(visited.has(item))return false;
      visited.add(item);
      if(item.role==='trust-anchor')return item.cert.checkIssued(item.cert)&&item.cert.verify(item.cert.publicKey);
      return certs.some(parent=>parent!==item&&item.cert.checkIssued(parent.cert)&&item.cert.verify(parent.cert.publicKey)&&reachesRoot(parent,new Set(visited)));
    }
    for(const item of certs)if(!reachesRoot(item))issues.push(`${item.file}: Cannot verify chain to the bundled root`);
  }catch(error){issues.push(error.message);}
  return {ready:issues.length===0,count:certs.length,trustDir:path.resolve(trustDir),issues};
}
module.exports={checkCertificates};
