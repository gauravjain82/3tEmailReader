const {genericInvoiceParser,first,date}=require('./genericInvoiceParser');
const {decimal}=require('../decimal');

function parsePage(text){
  const doc=genericInvoiceParser(text);
  const header=text.match(/GST Inv\. No\.\s+([A-Z0-9/-]+)\s+Inv Dt\.\s+PO No\.\s+PO Dt\.\s+(\d{2}\.\d{2}\.\d{4})\s+([A-Z0-9/-]+)/i);
  doc.invoiceNumber=header?.[1]||null;doc.rawInvoiceDate=header?.[2]||null;doc.invoiceDate=date(doc.rawInvoiceDate);doc.purchaseOrderNumber=header?.[3]||null;
  doc.sellerName=first(text,/Company Name:\s*([^\n]+)/i);
  const billed=text.split(/Billed To:/i)[1]?.split(/Shipped To:/i)[0]||'';
  doc.sellerGstin=first(text.split(/Billed To:/i)[0],/GSTIN\/UIN:\s*(\w{15})/i);
  const buyer=first(billed,/Name:\s*\nPAN NO:\s*\n([\s\S]*?)\n[A-Z]{5}\d{4}[A-Z]\b/i);
  doc.buyerName=buyer?.replace(/\s+/g,' ').trim()||null;
  doc.buyerGstin=first(billed,/GSTIN\/UIN:\s*(\w{15})/i);
  const tax=text.match(/Taxable Value\s+CGST\s+SGST\s+([\d.]+)\s*%\s+([\d.]+)\s*%\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)/i);
  const grand=text.match(/Total Quantity\s*:\s*([\d,.]+)\s+([A-Z]+)\s+Total Invoice Value\(INR\)\s+([\d,.]+)/i);
  doc.taxableAmount=decimal(tax?.[3]);doc.cgst=decimal(tax?.[4]);doc.sgst=decimal(tax?.[5]);doc.igst=tax?'0.00':null;doc.totalAmount=decimal(grand?.[3]);
  const body=text.match(/Total Value\s*\n\(INR\)\s*\n([\s\S]*?)\nTaxable Value/i)?.[1];
  const rowPattern=/(?:^|\n)(\d{1,4})[ \t]+([A-Z][A-Z0-9]{5,25})\s*\n([\s\S]*?)\n(\d{5}M[A-Z0-9]+(?:[ \t]*-[ \t]*(?:\r?\n[ \t]*)?\d{3})?)\s*\n(\d{4,8})[ \t]+([\d,.]+)\s*\n([A-Z]+)\s*\n([\d,.]+)[ \t]+INR[ \t]+([\d,.]+)[ \t]+([\d,.]+)[ \t]*(?=\n|$)/g;
  const rows=body?[...body.matchAll(rowPattern)]:[];
  doc.lineItems=[];
  // The supplied layout prints a single item and its CGST/SGST summary.
  // Do not distribute header taxes across unsupported multi-item tables.
  if(rows.length===1&&tax&&grand&&!body.replace(rowPattern,'').trim()){
    const m=rows[0],quantity=decimal(m[6],6),unitPrice=decimal(m[9],6),taxableAmount=decimal(m[10]);
    if(quantity&&unitPrice&&taxableAmount&&quantity===decimal(grand[1],6)&&m[7]===grand[2])doc.lineItems.push({lineNumber:Number(m[1]),materialCode:m[2],description:m[3].replace(/\s+/g,' ').trim(),partNumber:m[4].replace(/\s/g,''),hsnSac:m[5],quantity,unit:m[7],basicRate:decimal(m[8],6),unitPrice,taxableAmount,cgstRate:decimal(tax[1]),cgst:doc.cgst,sgstRate:decimal(tax[2]),sgst:doc.sgst,igstRate:'0.00',igst:'0.00'});
  }
  doc.partNumbers=doc.lineItems.map(i=>i.partNumber);
  // This CIE template writes its reference values after the registered-office
  // footer, separated from the IRN/Eway labels near the invoice header.
  if(/Eway Bill No:/i.test(text)&&/Eway Valid To:/i.test(text)&&/IRN No:/i.test(text)){
    const tail=text.slice(text.search(/IRN No:/i));
    const irns=new Set(doc.irnCandidates),eways=new Set(doc.ewayBillCandidates);
    for(const m of tail.matchAll(/(?:^|\n)([a-f0-9]{64})[ \t]*\r?\n[ \t]*(\d{12})[ \t]*\r?\n[ \t]*(\d{4}-\d{2}-\d{2}[ \t]+\d{2}:\d{2}:\d{2})(?=\s|$)/gi)){irns.add(m[1].toLowerCase());eways.add(m[2]);}
    doc.irnCandidates=[...irns];doc.irn=irns.size===1?[...irns][0]:null;
    doc.ewayBillCandidates=[...eways];doc.ewayBillNumber=eways.size===1?[...eways][0]:null;
  }
  doc.evidence=['CIE Automotive invoice header, billed-to party and single-item CGST/SGST table extracted from labeled fields','Wrapped customer-part suffixes joined; material code retained separately; current net rate used for quantity reconciliation'];
  if(!doc.lineItems.length)doc.evidence.push('Unsupported or ambiguous CIE item table/quantity requires review');
  return doc;
}

function cieInvoiceParser(text){
  const pages=text.split(/\f|--\s*\d+\s+of\s+\d+\s*--/i).filter(p=>/Company Name:\s*CIE Automotive India Limited/i.test(p)&&/GST Inv\. No\./i.test(p));
  const docs=pages.map(parsePage),doc=docs[0]||parsePage(text);
  if(docs.length>1){
    const fields=['invoiceNumber','invoiceDate','sellerGstin','buyerGstin','taxableAmount','cgst','sgst','igst','totalAmount','lineItems'];
    if(docs.some(d=>fields.some(f=>JSON.stringify(d[f])!==JSON.stringify(doc[f])))){
      doc.lineItems=[];doc.partNumbers=[];
      if(docs.some(d=>d.invoiceNumber!==doc.invoiceNumber))doc.invoiceNumber=null;
      doc.evidence.push('Conflicting copies or unsupported multi-page CIE invoice requires review');
    }
    for(const [list,key] of [['irnCandidates','irn'],['ewayBillCandidates','ewayBillNumber']]){doc[list]=[...new Set(docs.flatMap(d=>d[list]))];doc[key]=doc[list].length===1?doc[list][0]:null;}
  }
  return doc;
}
module.exports={cieInvoiceParser};
