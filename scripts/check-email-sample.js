require('dotenv').config({quiet:true});
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {gmail,root,gmailErrorMessage}=require('../src/common');
const {loadConfig,validateConfig,senderAddress}=require('../src/config');
const {openStore,atomicWrite}=require('../src/storage/store');
const {withRetry,processMessage}=require('../src/gmail/processMessage');

async function main(){
  const config=validateConfig(loadConfig(root)),api=gmail();
  const outputDir=path.join(root,'data','email-samples',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8));
  const store=openStore(outputDir),report={outputDir,emails:[],errors:[],invoices:[]};
  console.log('Sample output:',outputDir);
  try{
    for(const sender of config.allowedSenders){
      try{
        const {data}=await withRetry(()=>api.users.messages.list({userId:'me',q:`from:${sender} has:attachment filename:pdf`,maxResults:10}));
        const candidates=[];
        for(const {id} of data.messages||[]){
          const {data:m}=await withRetry(()=>api.users.messages.get({userId:'me',id,format:'metadata',metadataHeaders:['From']}));
          const from=m.payload?.headers?.find(h=>h.name?.toLowerCase()==='from')?.value;
          if(senderAddress(from)===sender)candidates.push({id,time:Number(m.internalDate)||0});
        }
        candidates.sort((a,b)=>b.time-a.time);
        for(const m of candidates.slice(0,2)){
          console.log('Checking email:',sender,m.id);
          const result=await processMessage(api,m.id,store,outputDir,{...config,exportAfter:false});
          report.emails.push({sender,id:m.id,receivedAt:new Date(m.time).toISOString(),...result});
        }
      }catch(e){const error=gmailErrorMessage(e);report.errors.push({sender,error});console.error(error);if(/invalid_grant/.test(error))break;}
    }
    store.exportAll();
    report.invoices=store.db.prepare('SELECT filename,invoice_number,parser_name,validation_status,eway_bill_number,validation_json FROM invoices WHERE duplicate_of IS NULL ORDER BY id').all().map(({validation_json,...row})=>({...row,issues:JSON.parse(validation_json||'{}').issues||[]}));
    atomicWrite(path.join(outputDir,'sample-report.json'),JSON.stringify(report,null,2));
    const summary={emails:report.emails.length,invoices:report.invoices.length,withEwayBill:report.invoices.filter(i=>i.eway_bill_number).length,needsReview:report.invoices.filter(i=>i.validation_status!=='VALIDATED').length,errors:report.errors.length,outputDir};
    console.log(JSON.stringify(summary,null,2));
    if(report.errors.length||report.emails.some(m=>m.failed))process.exitCode=1;
    return report;
  }finally{store.close();}
}
if(require.main===module)main().catch(e=>{console.error(gmailErrorMessage(e));process.exitCode=1;});
module.exports={main};
