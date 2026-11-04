const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {promisify}=require('util');
const execute=promisify(require('child_process').execFile);
const root=path.resolve(__dirname,'../..');

async function verifyPdfSignature(pdfPath,expectedHash,{run=execute,python=process.env.SIGNATURE_PYTHON || path.join(root,'.signature-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),trustDir=process.env.SIGNATURE_TRUST_DIR || path.join(root,'certificates','trusted-roots'),allowLegacySha1=process.env.SIGNATURE_ALLOW_LEGACY_SHA1==='true'}={}) {
  const fail=(status,reason)=>({schemaVersion:1,status,reason,checkedAt:new Date().toISOString(),signatures:[]});
  try {
    const hash=crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex');
    if (!expectedHash || hash!==expectedHash) return fail('INVALID','Original PDF SHA-256 differs from the download');
    if (!fs.existsSync(python)) return fail('ERROR','Signature verifier is not installed. Run Setup Signature Verification.cmd on this PC.');
    const args=[path.join(root,'scripts','verify_pdf_signature.py'),path.resolve(pdfPath),'--trust-dir',path.resolve(trustDir)];
    if(allowLegacySha1===true)args.push('--allow-legacy-sha1');
    const {stdout}=await run(python,args,{windowsHide:true,timeout:90000,maxBuffer:2*1024*1024});
    const report=JSON.parse(stdout.trim());
    if (report.schemaVersion!==1 || !['VALID','INVALID','UNKNOWN','UNSIGNED','ERROR'].includes(report.status) || !Array.isArray(report.signatures)) return fail('ERROR','Invalid response from signature verifier');
    if (report.status==='VALID' && (report.sha256!==hash || !report.signatures.length || report.signatures.some(s=>s.status!=='VALID' || s.intact!==true || s.cryptographicallyValid!==true || s.trusted!==true) || report.signatures.at(-1).coverage!=='ENTIRE_FILE')) return fail('ERROR','Incomplete signature verification result');
    const after=crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex');
    if (after!==hash) return fail('INVALID','Original PDF changed during verification');
    return report;
  } catch (error) { return fail('ERROR',`Signature verification could not complete: ${error.message}`); }
}
function recordSignatureCheck(store,item,report) {
  store.db.prepare(`INSERT INTO signature_checks(invoice_number,source_sha256,source_pdf_path,status,reason,checked_at,result_json)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(invoice_number,source_sha256) DO UPDATE SET source_pdf_path=excluded.source_pdf_path,status=excluded.status,reason=excluded.reason,checked_at=excluded.checked_at,result_json=excluded.result_json`)
    .run(item.invoiceNumber,item.sourceSha256 || item.sha256,item.sourcePdfPath || item.pdfPath,report.status,report.reason || '',report.checkedAt || new Date().toISOString(),JSON.stringify(report));
}
module.exports={verifyPdfSignature,recordSignatureCheck};
