const path=require('path');
const readline=require('node:readline/promises');
const {loadConfig}=require('../src/config');
const {parseResetTime,resetCheckpoint}=require('../src/services/resetCheckpointService');
async function main(){
  const root=path.resolve(__dirname,'..');
  require('dotenv').config({path:path.join(root,'.env'),quiet:true});
  const config=loadConfig(root);
  const today=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date()).replaceAll('/','-');
  console.log('Reset the Gmail start time for the senders configured in config.json.');
  console.log('All dates and times are India Standard Time (IST, UTC+05:30).');
  console.log('Saved invoices, PDFs and print history are retained. Already processed attachments remain skipped.');
  console.log('Close the extractor first. Enter Q at either prompt to cancel.');
  const prompt=readline.createInterface({input:process.stdin,output:process.stdout});
  let date,time;
  try{
    date=(await prompt.question(`Start date DD-MM-YYYY [${today}]: `)).trim()||today;
    if(/^q$/i.test(date)){console.log('Cancelled. Start time unchanged.');return;}
    time=(await prompt.question('Start time HH:MM (24-hour IST) [06:00]: ')).trim()||'06:00';
    if(/^q$/i.test(time)){console.log('Cancelled. Start time unchanged.');return;}
  }finally{prompt.close();}
  const since=parseResetTime(date,time);
  resetCheckpoint({dataDir:path.join(root,'data'),config,since,baseQuery:process.env.GMAIL_QUERY||'in:inbox has:attachment filename:pdf'});
  console.log(`Gmail start time reset to ${date} ${time} IST.`);
  console.log('Now launch the invoice extractor and select Keep previous results.');
}
if(require.main===module)main().catch(error=>{console.error('Reset failed:',error.message);process.exitCode=1;});
module.exports={main};
