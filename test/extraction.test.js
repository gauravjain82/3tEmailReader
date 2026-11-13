const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { processText, processPdf } = require('../src/services/invoiceProcessingService');
const { extractText } = require('../src/pdf/extractText');
const { detectDocumentType } = require('../src/pdf/detectDocumentType');
const { validateGstin, gstins } = require('../src/pdf/validators/gstinValidator');
const { validDate } = require('../src/pdf/validators/invoiceValidator');
const { decimal, sum, productMinor } = require('../src/pdf/decimal');
const { openStore } = require('../src/storage/store');
const { reprocess } = require('../src/services/reprocessingService');
const { processMessage, withRetry, safe } = require('../src/gmail/processMessage');

const pdfDir = path.resolve(__dirname,'../data/pdfs');
const samples = {};
before(async () => {
  for (const [key,suffix] of Object.entries({ fst:'800450413.pdf', hub:'23_12627110031_1.pdf', bin:'KKD_MOR_BIN_TAG_4-11-26.pdf', colour:'KKD_MOR_CC_4-11-26.pdf' })) {
    const file = fs.existsSync(pdfDir) && fs.readdirSync(pdfDir).find(f => f.endsWith(suffix));
    if (file) { const filePath=path.join(pdfDir,file); samples[key]={ filePath, bytes:fs.readFileSync(filePath), text:await extractText(filePath) }; }
  }
});
function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'invoice-test-'));
  const store = openStore(dir);
  t.after(() => {
    store.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('invoice-test-'));
    fs.rmSync(dir,{recursive:true,force:true});
  });
  return { store, dir };
}
function metadata(dir, bytes) {
  const pdf_path = path.join(dir,'original.pdf'); fs.writeFileSync(pdf_path,bytes);
  return { gmail_id:'message-1', attachment_key:'attachment-1', sender:'sender@example.test', subject:'Original subject', filename:'invoice.pdf', pdf_path, sha256:crypto.createHash('sha256').update(bytes).digest('hex'), received_at:'2026-11-03T00:00:00.000Z' };
}

test('classification uses content and handles all five types', () => {
  for (const [text,type] of [['TAX INVOICE','TAX_INVOICE'],['Bin No. 1/2 QTY/BIN 10','BIN_TAG'],['Consignment No: 22 UNLOAD CARDS 3','COLOUR_CODE_DOCUMENT'],['Packing List','OTHER'],['unrecognized text','UNKNOWN']]) assert.equal(detectDocumentType(text).type,type);
});
test('labels are rejected as identifiers; malformed dates and fields require review', () => {
  const d = processText('Tax Invoice\nInvoice No: GSTIN\nPart No: HSN\nVendor Code: GSTIN\nInvoice Date: 31/02/2026');
  assert.equal(d.invoiceNumber,null); assert.equal(d.vendorCode,null); assert.deepEqual(d.partNumbers,[]);
  assert.equal(d.validation.status,'NEEDS_REVIEW'); assert.ok(d.validation.issues.some(i => i.field === 'invoiceDate'));
  assert.equal(validDate('2024-02-29'),true); assert.equal(validDate('2026-02-29'),false);
  assert.equal(processText('Bin No. 1/2 QTY/BIN 10').validation.status,'NOT_APPLICABLE');
});
test('GSTIN uniqueness, state, structure and checksum validation', () => {
  assert.deepEqual(gstins('06AAFCS0306K1ZL 06AAFCS0306K1ZL'),['06AAFCS0306K1ZL']);
  for (const g of ['06AAFCS0306K1ZL','06AAACM0829Q3Z6','34AAECM7741D1ZN','06AAACM0829Q1Z8']) assert.equal(validateGstin(g),true,g);
  for (const g of [null,'GSTIN','06AAFCS0306K1ZA','00AAFCS0306K1ZL']) assert.equal(validateGstin(g),false);
});
test('exact decimal arithmetic handles large amounts without float rounding', () => {
  assert.equal(decimal('57,112.00'),'57112.00'); assert.equal(decimal('12.345'),null); assert.equal(decimal('1,2.00'),null);
  assert.equal(sum(['9007199254740993.01','0.09']),900719925474099310n);
  assert.equal(productMinor('60','97.32'),583920n);
});
test('real FST header, GSTIN roles, wrapped item description and repeated copies', t => {
  if (!samples.fst) return t.skip('Local FST PDF unavailable');
  const d = processText(samples.fst.text);
  assert.equal(d.invoiceNumber,'DS0003468303'); assert.equal(d.invoiceDate,'2026-11-03'); assert.equal(d.vendorCode,'X209');
  assert.equal(d.sellerGstin,'06AAFCS0306K1ZL'); assert.equal(d.buyerGstin,'06AAACM0829Q3Z6');
  assert.equal(d.totalAmount,'57112.00'); assert.equal(d.lineItems.length,1); assert.equal(d.lineItems[0].lineNumber,1);
  assert.equal(d.lineItems[0].description,'0040621179 VA03 5,0-46 8,90/11,65X 9,30 595');
  assert.deepEqual(d.partNumbers,['12934M74L00']); assert.equal(d.lineItems[0].quantity,'8000.000000');
  assert.equal(d.validation.status,'VALIDATED');
});
test('real HUB reversed columns extract invoice, vendor, taxes and total', t => {
  if (!samples.hub) return t.skip('Local HUB PDF unavailable');
  const d = processText(samples.hub.text);
  assert.equal(d.invoiceNumber,'12627110031'); assert.equal(d.invoiceDate,'2026-10-21'); assert.equal(d.vendorCode,'T460');
  assert.equal(d.sellerGstin,'34AAECM7741D1ZN'); assert.equal(d.buyerGstin,'06AAACM0829Q1Z8');
  assert.equal(d.totalAmount,'6890.26'); assert.equal(d.igst,'1051.06'); assert.equal(d.lineItems.length,1);
  assert.equal(d.lineItems[0].description,'HUB, 5TH SPEED SYNC'); assert.deepEqual(d.partNumbers,['24413M68P40']); assert.equal(d.validation.status,'VALIDATED');
});
test('multiple FST lines survive copy deduplication and reconcile', t => {
  if (!samples.fst) return t.skip('Local FST PDF unavailable');
  const originalRow = '1 0040621179 VA03 5,0-46 8,90/11,65X\n9,30 595\n12934M74L00 40169330 8,000 PC 6.05 1 48,400.00 9.00 4,356.00 9.00 4,356.00';
  const secondRow = '2 SECOND ITEM\nPART002 40169330 10 PC 2.00 1 20.00 9.00 1.80 9.00 1.80';
  let text = samples.fst.text.replaceAll(originalRow,originalRow+'\n'+secondRow).replaceAll('Subtotal 48,400.00','Subtotal 48,420.00').replaceAll('CGST 4,356.00','CGST 4,357.80').replaceAll('SGST 4,356.00','SGST 4,357.80').replaceAll('Grand Total 57,112.00','Grand Total 57,135.60');
  const d = processText(text);
  assert.equal(d.lineItems.length,2); assert.equal(d.validation.status,'VALIDATED');
  const broken = processText(text.replaceAll('Grand Total 57,135.60','Grand Total 57,135.61'));
  assert.equal(broken.validation.status,'NEEDS_REVIEW');
});
test('real logistics documents do not become invoices', t => {
  if (!samples.bin || !samples.colour) return t.skip('Local logistics PDFs unavailable');
  assert.equal(processText(samples.bin.text).documentType,'BIN_TAG');
  assert.equal(processText(samples.colour.text).documentType,'COLOUR_CODE_DOCUMENT');
  assert.equal(processText(samples.colour.text).validation.status,'NOT_APPLICABLE');
});
test('PDF failure is FAILED, never a successful extraction', async () => {
  assert.equal((await processPdf(Buffer.from('not a pdf'))).validation.status,'FAILED');
});
test('reprocessing preserves IDs, metadata and timestamp without duplicate records', async t => {
  if (!samples.hub) return t.skip('Local HUB PDF unavailable');
  const {store,dir} = tempStore(t); const meta = metadata(dir,samples.hub.bytes);
  const first = store.save(meta,processText(samples.hub.text));
  await reprocess(store); await reprocess(store,{documentType:'TAX_INVOICE',status:'VALIDATED'});
  const row = store.db.prepare('SELECT * FROM invoices').get();
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoice_line_items').get().n,1);
  assert.equal(row.id,first.id); assert.equal(row.sender,meta.sender); assert.equal(row.subject,meta.subject); assert.equal(row.sha256,meta.sha256);
  assert.equal(row.processed_at,first.processed_at); assert.ok(row.reprocessed_at); assert.equal(row.parser_version,require('../src/pdf/parserRegistry').PARSER_VERSION);
  assert.equal(store.db.prepare('SELECT count(*) n FROM extraction_runs').get().n,3);
  assert.equal(JSON.parse(fs.readFileSync(row.json_path)).validation.status,'VALIDATED');
  assert.equal(fs.readFileSync(path.join(dir,'invoices.csv'),'utf8').split('\r\n')[0],'invoice_number,invoice_date,part_number,quantity,taxable_amount,IRN No,email_subject,E-Way Bill No');
  assert.equal((await reprocess(store,{status:'FAILED'})).processed,0);
});
test('failed or empty re-extraction retains previous values with explicit review/history', async t => {
  if (!samples.hub) return t.skip('Local HUB PDF unavailable');
  const {store,dir} = tempStore(t); const meta = metadata(dir,samples.hub.bytes);
  store.save(meta,processText(samples.hub.text));
  store.save(meta,processText('Tax Invoice\nInvoice No: GSTIN'),{reprocess:true});
  let row = store.db.prepare('SELECT * FROM invoices').get();
  assert.equal(row.invoice_number,'12627110031'); assert.equal(row.validation_status,'NEEDS_REVIEW');
  assert.ok(JSON.parse(row.validation_json).issues.some(i => i.field === 'retainedFields'));
  fs.writeFileSync(meta.pdf_path,'tampered'); await reprocess(store);
  row = store.db.prepare('SELECT * FROM invoices').get(); assert.equal(row.validation_status,'FAILED'); assert.equal(row.total_amount,'6890.26');
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoice_line_items').get().n,1);
});
test('Gmail duplicate prevention and retry reuse the downloaded local PDF', async t => {
  if (!samples.fst) return t.skip('Local FST PDF unavailable');
  const {store,dir} = tempStore(t); let downloads = 0;
  const api = {users:{messages:{get:async()=>({data:{internalDate:'1793664000000',payload:{headers:[],parts:[{mimeType:'application/pdf',filename:'../../invoice.pdf',body:{attachmentId:'attachment-1'}}]}}}),attachments:{get:async()=>{ downloads++; return {data:{data:samples.fst.bytes.toString('base64url')}}; }}}}};
  await processMessage(api,'message-1',store,dir); await processMessage(api,'message-1',store,dir);
  assert.equal(downloads,1); assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.equal(store.find('message-1','part-1').attempts,1);
  store.db.prepare("UPDATE attachments SET status='failed'").run();
  await processMessage(api,'message-1',store,dir); assert.equal(downloads,1);
  assert.ok(!safe('../../invoice.pdf').includes('/'));
});
test('changing Gmail attachment IDs do not create new records for a stable MIME part', async t => {
  if (!samples.hub) return t.skip('Local HUB PDF unavailable');
  const {store,dir} = tempStore(t); let generation=0, downloads=0;
  const api={users:{messages:{get:async()=>({data:{payload:{parts:[{partId:'2.1',mimeType:'application/pdf',filename:'same.pdf',body:{attachmentId:'temporary-'+(++generation)}}]}}}),attachments:{get:async()=>{downloads++;return {data:{data:samples.hub.bytes.toString('base64url')}};}}}}};
  await processMessage(api,'stable-message',store,dir); await processMessage(api,'stable-message',store,dir);
  assert.equal(downloads,1); assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.equal(store.find('stable-message','part-2.1').status,'done');
  // Simulate the old downloader's changing key. The path still identifies the legacy MIME index.
  const current=store.db.prepare('SELECT pdf_path FROM invoices').get().pdf_path;
  assert.equal(path.basename(current),'same.pdf');
  const legacyPath=path.join(dir,'pdfs','stable-message-1-legacy-same.pdf');
  fs.copyFileSync(current,legacyPath);
  store.db.prepare('UPDATE invoices SET pdf_path=?').run(legacyPath);
  store.db.prepare("UPDATE attachments SET attachment_key='legacy-key'").run();
  store.db.prepare("UPDATE invoices SET attachment_key='legacy-key'").run();
  await processMessage(api,'stable-message',store,dir);
  assert.equal(downloads,1); assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
});
test('same invoice in two MIME parts is stored once with both attachment origins retained', async t => {
  if (!samples.hub) return t.skip('Local HUB PDF unavailable');
  const {store,dir} = tempStore(t);
  const p = partId => ({partId,mimeType:'application/pdf',filename:'same.pdf',body:{data:samples.hub.bytes.toString('base64url')}});
  const api={users:{messages:{get:async()=>({data:{payload:{parts:[p('1'),p('2')]}}})}}};
  await processMessage(api,'two-parts',store,dir); await processMessage(api,'two-parts',store,dir);
  assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM duplicate_attachments').get().n,1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM attachments').get().n,2);
});
test('export interruption preserves committed results and exports can be recovered', t => {
  if (!samples.hub) return t.skip('Local HUB PDF unavailable');
  const {store,dir} = tempStore(t); const meta=metadata(dir,samples.hub.bytes);
  store.save(meta,processText(samples.hub.text));
  fs.mkdirSync(path.join(dir,'invoices.csv'));
  assert.throws(()=>store.exportAll()); assert.equal(store.find(meta.gmail_id,meta.attachment_key).status,'done');
  fs.rmdirSync(path.join(dir,'invoices.csv')); store.exportAll();
  assert.ok(fs.readFileSync(path.join(dir,'invoices.csv'),'utf8').includes('12627110031'));
});
test('retained invoice reference on a logistics document remains NOT_APPLICABLE', t => {
  const {store,dir}=tempStore(t); const meta=metadata(dir,Buffer.from('legacy'));
  store.save(meta,processText('Tax Invoice\nInvoice No: REF123'));
  store.save(meta,processText('Bin No 1 QTY/BIN 20'),{reprocess:true});
  const row=store.db.prepare('SELECT * FROM invoices').get();
  assert.equal(row.invoice_number,'REF123'); assert.equal(row.validation_status,'NOT_APPLICABLE');
});
test('backward-compatible migration retains legacy row IDs and columns', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'invoice-test-'));
  const original = new Database(path.join(dir,'invoices.db'));
  original.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY,gmail_id TEXT,attachment_key TEXT,sender TEXT,subject TEXT,filename TEXT,sha256 TEXT,invoice_number TEXT,invoice_date TEXT,vendor_code TEXT,gstins_json TEXT,part_numbers_json TEXT,total_amount TEXT,text_excerpt TEXT,json_path TEXT,pdf_path TEXT,processed_at TEXT NOT NULL,UNIQUE(gmail_id,attachment_key));
    INSERT INTO invoices(id,gmail_id,attachment_key,invoice_number,total_amount,processed_at) VALUES(42,'m','a','INV001','1,234.00','2026-01-01');`); original.close();
  const store = openStore(dir);
  try { const row=store.db.prepare('SELECT * FROM invoices').get(); assert.equal(row.id,42); assert.equal(row.total_amount,'1,234.00'); assert.equal(row.validation_status,null); assert.equal(store.db.pragma('integrity_check',{simple:true}),'ok'); }
  finally { store.close(); assert.equal(path.dirname(dir),path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('invoice-test-')); fs.rmSync(dir,{recursive:true,force:true}); }
});
test('quota retry is bounded and authentication errors are not retried', async () => {
  let calls=0; const waits=[];
  const value = await withRetry(async()=>{ if (++calls < 3) throw {response:{status:429}}; return 'ok'; },async ms=>waits.push(ms));
  assert.equal(value,'ok'); assert.deepEqual(waits,[1000,2000]);
  calls=0; await assert.rejects(withRetry(async()=>{calls++;throw Error('unauthorized');},async()=>{})); assert.equal(calls,1);
});
