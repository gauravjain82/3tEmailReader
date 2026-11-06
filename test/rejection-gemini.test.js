const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {PDFDocument}=require('pdf-lib');
const {settings,endpoint,createVertexClient,normalize,createGeminiExtractor}=require('../src/rejections/gemini');
const {runBatch,options}=require('../scripts/parse-rejections');
const item=()=>({item_name:'12221M81R10-300',quantity:'2.00',unit_price:'5.00',basic_value:'10.00',packing_charges:'1.00',cgst_amount:'.99',sgst_amount:'0.99',total_value:'12.98',uncertain_fields:[]});
function invoice(){const i=item();i.cgst_amount='0.99';return {document_type:'REJECTION_INVOICE',invoice_number:'HE1000000001',invoice_date:'27.10.2026',supplier_city:'MANESAR',ack_number:'7800000001',ack_date:'28.10.2026',ack_uncertain:false,items:[i],warnings:[]};}
const config=()=>settings({REJECTION_GEMINI_MODEL:'gemini-3-flash-preview',GOOGLE_CLOUD_PROJECT:'example-project',GOOGLE_CLOUD_LOCATION:'global'});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rejection-gemini-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('Vertex settings validate configuration and separate API keys from ADC',()=>{
  assert.throws(()=>settings({}),/REJECTION_GEMINI_MODEL/);
  assert.throws(()=>settings({REJECTION_GEMINI_MODEL:'gemini-test'}),/GOOGLE_CLOUD_PROJECT/);
  assert.match(endpoint(config()),/^https:\/\/aiplatform.googleapis.com\/v1\/projects\/example-project\/locations\/global\/publishers/);
  const keyed=settings({REJECTION_GEMINI_MODEL:'gemini-test',VERTEX_API_KEY:'secret-for-test'});
  assert.equal(keyed.mode,'api-key');assert.ok(!endpoint(keyed).includes('secret-for-test'));assert.ok(!endpoint(keyed).includes('/projects/'));
  assert.throws(()=>settings({...config(),REJECTION_GEMINI_MODEL:'gemini-test',GOOGLE_CLOUD_PROJECT:'example',GOOGLE_CLOUD_LOCATION:'other.example.com'}),/LOCATION/);
});

test('Vertex sends the PDF with a schema and returns structured output without logging credentials',async()=>{
  let request;
  const client=createVertexClient(config(),{authFactory:()=>({getAccessToken:async()=>'fake-access-token'}),fetchImpl:async(url,opts)=>{request={url,...opts};return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(invoice())}]}}],usageMetadata:{totalTokenCount:100}})};}});
  const result=await client.generate(Buffer.from('%PDF-fake'));
  const body=JSON.parse(request.body);
  assert.equal(request.headers.Authorization,'Bearer fake-access-token');assert.ok(!request.url.includes('fake-access-token'));
  assert.equal(body.contents[0].parts[0].inlineData.mimeType,'application/pdf');
  assert.equal(Buffer.from(body.contents[0].parts[0].inlineData.data,'base64').toString(),'%PDF-fake');
  assert.equal(body.generationConfig.responseMimeType,'application/json');assert.ok(body.generationConfig.responseSchema.properties.items);
  assert.equal(body.generationConfig.mediaResolution,'MEDIA_RESOLUTION_HIGH');
  assert.equal(result.document.invoice_number,'HE1000000001');
});

test('HTTP errors redact provider bodies and incomplete responses never become invoice rows',async()=>{
  const keyed=settings({REJECTION_GEMINI_MODEL:'gemini-test',VERTEX_API_KEY:'test-secret'});
  const denied=createVertexClient(keyed,{fetchImpl:async()=>({ok:false,status:403,json:async()=>({error:'test-secret'})})});
  await assert.rejects(denied.generate(Buffer.from('pdf')),e=>/Vertex HTTP 403/.test(e.message)&&!e.message.includes('test-secret'));
  const truncated=createVertexClient(keyed,{fetchImpl:async()=>({ok:true,json:async()=>({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:JSON.stringify(invoice())}]}}]})})});
  await assert.rejects(truncated.generate(Buffer.from('pdf')),/did not finish/);
});

test('Gemini fields retain the template, exact mappings, leading zeros and multiple items',()=>{
  const doc=invoice();doc.ack_number='0800000001';doc.items.push({...item(),item_name:'12221MZZZ99-300',cgst_amount:'0.99'});
  const p=normalize(doc,3);assert.equal(p.rows.length,2);assert.equal(p.page,3);
  const r=p.rows[0];assert.equal(r['PART NAME'],'F01948FG0000');assert.equal(r['Location(Plant)'],'Manesar(MF03)');assert.equal(r['Cust. Code'],'MFCM0MF03');
  assert.equal(r.Qty,'2');assert.equal(r['Total Value'],'12.98');assert.equal(r['Ack. No'],'0800000001');
  assert.equal(p.rows[1]['PART NAME'],'');assert.equal(p.rows[1]['Item Name'],'12221MZZZ99-300');assert.ok(p.issues.length);
});

test('invoice identity normalizes printed whitespace without changing or inventing digits',()=>{
  const doc=invoice();doc.invoice_number=' HE 10000 00001 ';
  const parsed=normalize(doc,1);assert.equal(parsed.invoiceNumber,'HE1000000001');
  assert.equal(parsed.rows[0]['Invoice Number'],'HE1000000001');
  doc.invoice_number='HE I000000001';assert.throws(()=>normalize(doc,1),/invoice number/);
});

test('uncertain fields, invalid dates, wrong quantities and unreconciled totals stay blank',()=>{
  const doc=invoice();doc.ack_uncertain=true;doc.invoice_date='31.11.2026';doc.items[0].quantity='200';doc.items[0].total_value='13.00';doc.items[0].uncertain_fields=['item_name'];
  const p=normalize(doc,1),r=p.rows[0];for(const f of ['Item Name','PART NAME','Ack. No','Ack Date','Invoice Date','Qty','Total Value'])assert.equal(r[f],'',f);
  const before=invoice();before.ack_date='26.10.2026';assert.equal(normalize(before,1).rows[0]['Ack Date'],'');
  assert.throws(()=>normalize({...invoice(),document_type:'OTHER'},1),/did not identify/);
  assert.throws(()=>normalize({...invoice(),invoice_number:'invented'},1),/invoice number/);
});

test('Gemini batch sends one page at a time, retains audit, isolates failures and deduplicates invoices',async t=>{
  const dir=fixture(t),file=path.join(dir,'scanned.pdf'),output=path.join(dir,'results');
  const pdf=await PDFDocument.create();for(let n=0;n<3;n++)pdf.addPage();fs.writeFileSync(file,await pdf.save());
  let calls=0;
  const cloud=createGeminiExtractor(config(),output,{client:{generate:async bytes=>{calls++;assert.equal((await PDFDocument.load(bytes)).getPageCount(),1);if(calls===2)throw Error('Unreadable page');return {document:invoice(),response:{usageMetadata:{totalTokenCount:10}}};}}});
  const summary=await runBatch({input:file,output,read:cloud.read,extract:cloud.extract,handwriting:null});
  assert.equal(calls,3);assert.equal(summary.rows,1);assert.equal(summary.duplicates,1);assert.equal(summary.failed,1);
  assert.equal(summary.comparedFields,0);assert.equal(fs.readdirSync(path.join(output,'gemini-audit')).length,2);
  const details=JSON.parse(fs.readFileSync(path.join(output,'details.json')));assert.equal(details[0].textSource,'vertex-gemini');assert.match(details[0].gemini.sourceSha256,/^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(dir,'token.json')),false);assert.equal(fs.existsSync(path.join(dir,'invoices.db')),false);
});

test('persistent auth/model/quota errors do not repeatedly call the paid API on remaining pages',async t=>{
  const dir=fixture(t),file=path.join(dir,'sample.pdf');const pdf=await PDFDocument.create();pdf.addPage();pdf.addPage();fs.writeFileSync(file,await pdf.save());let calls=0;
  const cloud=createGeminiExtractor(config(),dir,{client:{generate:async()=>{calls++;throw Error('Vertex HTTP 403. Check permissions.');}}});
  const pages=await cloud.read(file);for(const p of pages)await assert.rejects(cloud.extract(p,file),/403/);assert.equal(calls,1);
});

test('Gemini page selection is explicit and does not change default local options',()=>{
  assert.deepEqual(options([]),{});assert.deepEqual(options(['--engine','gemini','--pages','1,3,3']).pages,[1,3]);
  assert.throws(()=>options(['--engine','unknown']),/Usage/);assert.throws(()=>options(['--pages','0']),/Invalid/);assert.throws(()=>options(['--pages','1-3']),/Usage/);
});
