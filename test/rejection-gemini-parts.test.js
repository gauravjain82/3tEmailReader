const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const os=require('os');
const {PDFDocument}=require('pdf-lib');
const {needsPartCheck,reconcileParts,stretchGray}=require('../src/rejections/geminiPartCheck');
const {normalize,createGeminiExtractor,createVertexClient,settings}=require('../src/rejections/gemini');
const config=()=>settings({REJECTION_GEMINI_MODEL:'gemini-test',VERTEX_API_KEY:'fake-key'});
function document(){return {document_type:'REJECTION_INVOICE',invoice_number:'HG1000000001',invoice_date:'05.11.2026',supplier_city:'GURGAON',ack_number:null,ack_date:null,ack_uncertain:true,items:[{item_name:'12221M58P00-300',quantity:'4',unit_price:'10.00',basic_value:'40.00',packing_charges:'0.00',cgst_amount:'3.60',sgst_amount:'3.60',total_value:'47.20',uncertain_fields:[]}],warnings:[]};}
const reading=(table='12221M68PC0-300',material=table)=>({parts:[{line:1,table_part:table,material_part:material,uncertain:false}]});
test('dark gray scan paper becomes white without losing sparse dark strokes',()=>{
  const pixels=new Uint8ClampedArray(Array.from({length:100},(_,i)=>i<5?[40,40,40,255]:[170,170,170,255]).flat());
  stretchGray(pixels);assert.deepEqual([...pixels.slice(0,4)],[0,0,0,255]);assert.deepEqual([...pixels.slice(-4)],[255,255,255,255]);
  const blank=new Uint8ClampedArray([255,255,255,255,255,255,255,255]);stretchGray(blank);assert.ok(blank.every(v=>v===255));
});
test('unmapped, missing and explicitly uncertain item numbers trigger a focused check',()=>{
  assert.equal(needsPartCheck(document()),true);
  const doc=document();doc.items[0].item_name='12221M68PC0-300';assert.equal(needsPartCheck(doc),false);
  doc.items[0].uncertain_fields=['item_name'];assert.equal(needsPartCheck(doc),true);
  doc.items[0].item_name=null;assert.equal(needsPartCheck(doc),true);
});
test('two printed occurrences must agree exactly before a correction and mapped part name are published',()=>{
  const doc=document(),revised=reconcileParts(doc,reading());
  assert.equal(doc.items[0].item_name,'12221M58P00-300');
  assert.equal(revised.document.items[0].item_name,'12221M68PC0-300');
  assert.equal(normalize(revised.document,1).rows[0]['PART NAME'],'F01904FG0000');
  assert.equal(revised.changes[0].status,'REPEATED_PRINT_AGREEMENT');
  for(const result of [reading('12221M68PC0-300','12221M68PCD-300'),reading(null,null),null,{parts:[{...reading().parts[0],uncertain:true}]}]){
    const failed=reconcileParts(doc,result);assert.equal(failed.document.items[0].item_name,null);
    assert.equal(normalize(failed.document,1).rows[0]['Item Name'],'');
  }
});
test('unlisted genuine codes remain unmapped and mapped lines are not replaced by unrelated checks',()=>{
  const doc=document(),result=reconcileParts(doc,reading('12221MZZZ99-300'));
  const row=normalize(result.document,1).rows[0];assert.equal(row['Item Name'],'12221MZZZ99-300');assert.equal(row['PART NAME'],'');
  doc.items.push({...doc.items[0],item_name:'12221M72R00-300'});
  const checked=reconcileParts(doc,{parts:[...reading().parts,{line:2,table_part:'12221M68PC0-300',material_part:'12221M68PC0-300',uncertain:false}]});
  assert.equal(checked.document.items[1].item_name,'12221M72R00-300');
  const duplicate=reconcileParts(document(),{parts:[...reading().parts,...reading().parts]});assert.equal(duplicate.document.items[0].item_name,null);
});
test('focused request supplies images and a comparison schema, without a proposed correction or mappings',async()=>{
  let body;const client=createVertexClient(config(),{fetchImpl:async(_url,request)=>{body=JSON.parse(request.body);return {ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(reading())}]}}]})};}});
  const result=await client.verifyParts([{label:'Table',mimeType:'image/png',buffer:Buffer.from('table')},{label:'Material',mimeType:'image/png',buffer:Buffer.from('material')}],1);
  assert.equal(body.contents[0].parts.filter(p=>p.inlineData).length,2);
  assert.equal(body.generationConfig.mediaResolution,'MEDIA_RESOLUTION_HIGH');
  assert.ok(body.generationConfig.responseSchema.properties.parts.items.properties.material_part);
  assert.ok(!JSON.stringify(body).includes('12221M68PC0-300'));assert.equal(result.document.parts[0].table_part,'12221M68PC0-300');
});
test('automatic extractor saves both readings, applies focused correction, and does not change invoice identity',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-parts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pdf=await PDFDocument.create();pdf.addPage();const file=path.join(dir,'invoice.pdf');fs.writeFileSync(file,await pdf.save());
  let checks=0,closed=0;
  const extractor=createGeminiExtractor(config(),dir,{client:{generate:async(_pdf,options)=>{assert.equal(options.images[0].buffer.toString(),'private header');return {document:document(),response:{}};},verifyParts:async(images,count)=>{checks++;assert.equal(count,1);return {document:reading(),response:{usageMetadata:{totalTokenCount:5}}};}},cropFactory:()=>({renderHeader:async()=>[{label:'header',buffer:Buffer.from('private header'),file:'header.png'}],render:async()=>[{label:'table',buffer:Buffer.from('private crop'),file:'table.png'}],close:async()=>{closed++;}})});
  const [page]=await extractor.read(file),p=await extractor.extract(page,file);
  assert.equal(checks,1);assert.equal(closed,1);assert.equal(p.invoiceNumber,'HG1000000001');assert.equal(p.rows[0]['Item Name'],'12221M68PC0-300');assert.equal(p.rows[0]['PART NAME'],'F01904FG0000');
  const original=JSON.parse(fs.readFileSync(p.gemini.audit));assert.equal(original.document.items[0].item_name,'12221M58P00-300');
  assert.ok(!fs.readFileSync(p.gemini.audit,'utf8').includes('private header'));assert.equal(original.headerImages[0].file,'header.png');
  const audit=fs.readFileSync(p.gemini.partVerification.audit,'utf8');assert.ok(!audit.includes('private crop'));assert.equal(p.gemini.partVerification.changes[0].before,'12221M58P00-300');
});
test('header preparation failure keeps PDF extraction available and records the limitation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-header-failure-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pdf=await PDFDocument.create();pdf.addPage();const file=path.join(dir,'invoice.pdf');fs.writeFileSync(file,await pdf.save());let closed=0;
  const doc=document();doc.items[0].item_name='12221M72R00-300';
  const cloud=createGeminiExtractor(config(),dir,{client:{generate:async(_pdf,options)=>{assert.deepEqual(options.images,[]);return {document:doc,response:{}};}},cropFactory:()=>({renderHeader:async()=>{throw Error('Image renderer unavailable');},close:async()=>{closed++;}})});
  const [page]=await cloud.read(file),p=await cloud.extract(page,file);assert.equal(p.rows.length,1);assert.equal(closed,1);
  assert.ok(p.issues.some(i=>i.includes('header crops unavailable')));
});
test('focused verification errors preserve the row but do not publish the unconfirmed part code',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gemini-parts-failure-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const pdf=await PDFDocument.create();pdf.addPage();const file=path.join(dir,'invoice.pdf');fs.writeFileSync(file,await pdf.save());
  const cloud=createGeminiExtractor(config(),dir,{client:{generate:async()=>({document:document(),response:{}}),verifyParts:async()=>{throw Error('Vertex HTTP 429. Quota exceeded.');}},cropFactory:()=>({render:async()=>[],close:async()=>{}})});
  const [page]=await cloud.read(file),p=await cloud.extract(page,file);assert.equal(p.rows[0]['Item Name'],'');assert.equal(p.rows[0]['PART NAME'],'');
  assert.ok(p.issues.some(i=>i.includes('verification failed')));await assert.rejects(cloud.extract(page,file),/429/);
});
