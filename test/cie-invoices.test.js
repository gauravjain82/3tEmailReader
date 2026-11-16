const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {processText,processPdf}=require('../src/services/invoiceProcessingService');
const {processMessage}=require('../src/gmail/processMessage');
const {openStore}=require('../src/storage/store');
const irn='0123456789abcdef'.repeat(4);
function fixture(){return `TAX INVOICE
Company Name: CIE Automotive India Limited
GSTIN/UIN: 06AABCM6632J1ZG
Billed To: GM3232
Name:
PAN NO:
EXAMPLE BUYER
LIMITED
AAACM0829Q
GSTIN/UIN: 06AAACM0829Q4Z5
Shipped To: GM3232
GST Inv. No. IN000001
Inv Dt.
PO No.
PO Dt.
16.11.2026
602183
31.12.2025
Eway Bill No:
Eway Valid To:
Sr.No. Material Code/Description
Total Value
(INR)
10 F01904FG0000
MSIL K12 CRANKSHAFT
12221M68PC0-
300
73261990 2
EA
10.00 INR 10.00 20.00
Taxable Value
CGST
SGST
9.00 %
9.00 %
20.00
1.80
1.80
Total Quantity : 2.000 EA Total Invoice Value(INR) 23.60
IRN No:
For CIE Automotive India Limited
Reg. Off: Example office
${irn}
368010145431
2026-11-17 23:59:00
-- 1 of 1 --`;}

test('CIE single-item invoices extract wrapped/inline customer parts and net rates',()=>{
  for(const text of [fixture(),fixture().replace('12221M68PC0-\n300','12221M68PC0-300')]){
    const d=processText(text);assert.equal(d.parserName,'cie');assert.equal(d.validation.status,'VALIDATED',JSON.stringify(d.validation.issues));assert.equal(d.invoiceDate,'2026-11-16');assert.equal(d.purchaseOrderNumber,'602183');assert.equal(d.buyerName,'EXAMPLE BUYER LIMITED');assert.equal(d.lineItems[0].partNumber,'12221M68PC0-300');assert.equal(d.lineItems[0].materialCode,'F01904FG0000');assert.equal(d.lineItems[0].quantity,'2.000000');assert.equal(d.totalAmount,'23.60');
  }
  const net=processText(fixture().replace('10.00 INR 10.00','12.00 INR 10.00'));assert.equal(net.lineItems[0].basicRate,'12.000000');assert.equal(net.lineItems[0].unitPrice,'10.000000');assert.equal(net.validation.status,'VALIDATED');
});

test('CIE separated references require their labels and expose conflicting numbers for review',()=>{
  const d=processText(fixture());assert.equal(d.irn,irn);assert.equal(d.ewayBillNumber,'368010145431');
  const conflict=processText(fixture().replace('Eway Bill No:', 'Eway Bill No: 338010145432'));assert.equal(conflict.ewayBillNumber,null);assert.ok(conflict.validation.issues.some(i=>i.field==='ewayBillNumber'));
  const conflictIrn=processText(fixture().replace('IRN No:', 'IRN: '+'a'.repeat(64)+'\nIRN No:'));assert.equal(conflictIrn.irn,null);assert.ok(conflictIrn.validation.issues.some(i=>i.field==='irn'));
  assert.equal(processText(fixture().replace('Eway Bill No:','Unrelated reference:')).ewayBillNumber,null);
});

test('CIE incomplete tables, totals and unsupported multiple items stay reviewable',()=>{
  for(const text of [fixture().replace('2.000 EA','3.000 EA'),fixture().replace('10.00 INR 10.00 20.00','11.00 INR 11.00 20.00'),fixture().replace('Total Invoice Value(INR) 23.60','Total Invoice Value(INR) 99.00'),fixture().replace('GSTIN/UIN: 06AAACM0829Q4Z5','GSTIN/UIN: UNKNOWN')])assert.equal(processText(text).validation.status,'NEEDS_REVIEW');
  const row='10 F01904FG0000\nMSIL K12 CRANKSHAFT\n12221M68PC0-\n300\n73261990 2\nEA\n10.00 INR 10.00 20.00';
  const multi=processText(fixture().replace(row,row+'\n'+row.replace(/^10 /,'20 ')));assert.deepEqual(multi.lineItems,[]);assert.equal(multi.validation.status,'NEEDS_REVIEW');
});

test('CIE repeated copies count once and conflicting invoices within a PDF are not combined',()=>{
  const d=processText(fixture()+'\n'+fixture());assert.equal(d.lineItems.length,1);assert.equal(d.validation.status,'VALIDATED');
  const different=processText(fixture()+'\n'+fixture().replace('IN000001','IN000002'));assert.equal(different.invoiceNumber,null);assert.deepEqual(different.lineItems,[]);assert.equal(different.validation.status,'NEEDS_REVIEW');
});

const sampleDir=path.resolve(__dirname,'../data/email-samples/2026-11-16T06-51-30-998Z-ajaysharma/pdfs');
const samples=[['0203','12221M68PC0-300','200.000000','290290.00','368010145431'],['0204','12221M68PC0-300','200.000000','290290.00','338010145432'],['0205','12221M68PC0-300','100.000000','145145.00','308010145433'],['0206','12221M81R10-300','200.000000','269360.00','348010145435'],['0207','12221M81R10-300','200.000000','269360.00','318010145436'],['0208','12221M81R10-300','100.000000','134680.00','388010145437']];
test('all six downloaded CIE email PDFs validate with their printed parts, quantities and references',async t=>{
  let count=0;for(const [suffix,part,qty,taxable,eway] of samples){const file=path.join(sampleDir,suffix+' GGN.pdf');if(!fs.existsSync(file))continue;count++;const d=await processPdf(fs.readFileSync(file));assert.equal(d.parserName,'cie');assert.equal(d.invoiceNumber,'IN144701'+suffix);assert.equal(d.invoiceDate,'2026-11-16');assert.equal(d.lineItems.length,1);assert.equal(d.lineItems[0].partNumber,part);assert.equal(d.lineItems[0].quantity,qty);assert.equal(d.taxableAmount,taxable);assert.equal(d.ewayBillNumber,eway);assert.match(d.irn,/^[a-f0-9]{64}$/);assert.equal(d.validation.status,'VALIDATED',JSON.stringify(d.validation.issues));}
  if(!count)t.skip('Downloaded email samples unavailable');
});

test('automatic Gmail pipeline exports CIE PDFs and skips completed attachments on retry',async t=>{
  const file=path.join(sampleDir,'0203 GGN.pdf');if(!fs.existsSync(file))return t.skip('Downloaded email sample unavailable');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cie-gmail-')),store=openStore(dir);t.after(()=>{store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('cie-gmail-'));fs.rmSync(dir,{recursive:true,force:true});});
  const bytes=fs.readFileSync(file),m={internalDate:String(Date.parse('2026-11-16T06:21:23Z')),payload:{headers:[{name:'From',value:'ajaysharma.3t@gmail.com'},{name:'Subject',value:'MAHINDRA INVOICES'}],parts:[{partId:'1',filename:'0203 GGN.pdf',mimeType:'application/pdf',body:{data:bytes.toString('base64url')}}]}};
  const api={users:{messages:{get:async()=>({data:m})}}};const options={allowedSenders:['ajaysharma.3t@gmail.com']};assert.equal((await processMessage(api,'cie-mail',store,dir,options)).failed,false);await processMessage(api,'cie-mail',store,dir,options);
  const row=store.db.prepare('SELECT * FROM invoices').get();assert.equal(row.validation_status,'VALIDATED');assert.equal(row.eway_bill_number,'368010145431');assert.equal(store.db.prepare('SELECT count(*) n FROM invoices').get().n,1);
  const csv=fs.readFileSync(path.join(dir,'invoices.csv'),'utf8');assert.match(csv,/IN1447010203,2026-11-16,12221M68PC0-300,200,290290.00/);assert.match(csv,/368010145431/);assert.equal(csv.trim().split('\r\n').length,2);
});
