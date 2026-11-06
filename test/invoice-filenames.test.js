const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {PDFDocument,StandardFonts}=require('pdf-lib');
const {openStore}=require('../src/storage/store');
const {processMessage}=require('../src/gmail/processMessage');
const {validateConfig}=require('../src/config');
async function pdf(number,extra='Example description'){
  const doc=await PDFDocument.create();const font=await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText(`TAX INVOICE\nInvoice No: ${number}\nInvoice Date: 04.11.2026\n${extra}`,{x:40,y:700,font,size:12});
  return Buffer.from(await doc.save());
}
function setup(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invoice-filenames-'));const store=openStore(dir);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store};
}
function api(bytes,sender='Billing <ext.Lovinder.Singh@fst.com>',filename='800450557.pdf'){
  return {users:{messages:{get:async()=>({data:{payload:{headers:[{name:'From',value:sender}],parts:[{partId:'1',filename,mimeType:'application/pdf',body:{data:bytes.toString('base64url')}}]}}})}}};
}
const options={invoiceNumberFilenameSenders:['ext.lovinder.singh@fst.com']};
test('invoice-number sender configuration is optional, validated and normalized',()=>{
  const base={allowedSenders:['ext.lovinder.singh@fst.com']};
  assert.deepEqual(validateConfig(base).invoiceNumberFilenameSenders,[]);
  assert.deepEqual(validateConfig({...base,invoiceNumberFilenameSenders:[' ext.Lovinder.Singh@fst.com ']}).invoiceNumberFilenameSenders,options.invoiceNumberFilenameSenders);
  for(const value of ['sender@example.com',['*@fst.com'],[7]])assert.throws(()=>validateConfig({...base,invoiceNumberFilenameSenders:value}));
});
test('configured sender saves invoice-number PDF with unchanged bytes and original filename provenance',async t=>{
  const {dir,store}=setup(t);const bytes=await pdf('DS0003468341');
  await processMessage(api(bytes),'sigma',store,dir,options);
  const row=store.db.prepare('SELECT * FROM invoices').get();
  assert.equal(path.basename(row.pdf_path),'DS0003468341.pdf');assert.equal(row.filename,'800450557.pdf');
  assert.deepEqual(fs.readFileSync(row.pdf_path),bytes);
  assert.equal(row.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  await processMessage(api(bytes),'sigma',store,dir,options);
  assert.deepEqual(fs.readdirSync(path.join(dir,'pdfs')),['DS0003468341.pdf']);
  store.db.prepare("UPDATE attachments SET status='failed'").run();
  await processMessage(api(bytes),'sigma',store,dir,{});
  assert.equal(store.db.prepare('SELECT pdf_path FROM invoices').get().pdf_path,row.pdf_path);
});
test('other senders keep original names; missing number and failed PDFs fall back safely',async t=>{
  const {dir,store}=setup(t);
  await processMessage(api(await pdf('DS0003468341'),'other@example.com'),'other',store,dir,options);
  assert.equal(path.basename(store.db.prepare("SELECT pdf_path FROM invoices WHERE gmail_id='other'").get().pdf_path),'800450557.pdf');
  await processMessage(api(await pdf('UNKNOWN'),'ext.lovinder.singh@fst.com','missing.pdf'),'missing',store,dir,options);
  assert.equal(path.basename(store.db.prepare("SELECT pdf_path FROM invoices WHERE gmail_id='missing'").get().pdf_path),'missing.pdf');
  await processMessage(api(Buffer.from('invalid PDF'),'ext.lovinder.singh@fst.com','invalid.pdf'),'invalid',store,dir,options);
  const failed=store.db.prepare("SELECT * FROM invoices WHERE gmail_id='invalid'").get();
  assert.equal(path.basename(failed.pdf_path),'invalid.pdf');assert.equal(failed.validation_status,'FAILED');
});
test('invoice references are sanitized and different originals with the same invoice do not overwrite',async t=>{
  const {dir,store}=setup(t);const first=await pdf('INV/123'),second=await pdf('INV/123','Second original copy');
  await processMessage(api(first),'first',store,dir,options);
  const summary=await processMessage(api(second),'second',store,dir,options);
  assert.equal(summary.duplicates,1);
  assert.deepEqual(fs.readFileSync(path.join(dir,'pdfs','INV_123.pdf')),first);
  assert.deepEqual(fs.readFileSync(path.join(dir,'pdfs','INV_123 (2).pdf')),second);
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.equal(store.db.prepare('SELECT filename FROM duplicate_attachments').get().filename,'800450557.pdf');
});
