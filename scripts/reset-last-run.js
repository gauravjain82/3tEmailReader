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
  console.log('Saved invoices, PDFs and print history are retained.');
  console.log('Close the extractor first. Enter Q at any prompt to cancel.');
  const prompt=readline.createInterface({input:process.stdin,output:process.stdout});
  let date,time,mode;
  try{
    date=(await prompt.question(`Start date DD-MM-YYYY [${today}]: `)).trim()||today;
    if(/^q$/i.test(date)){console.log('Cancelled. Start time unchanged.');return;}
    time=(await prompt.question('Start time HH:MM (24-hour IST) [06:00]: ')).trim()||'06:00';
    if(/^q$/i.test(time)){console.log('Cancelled. Start time unchanged.');return;}
    parseResetTime(date,time);
    console.log('1. Reset time only (skip already processed attachments).');
    console.log('2. Replay all matching emails from this time, including attachments whose results were archived (default).');
    mode=(await prompt.question('Select [1/2], Enter for 2: ')).trim()||'2';
    if(/^q$/i.test(mode)){console.log('Cancelled. Start time unchanged.');return;}
    if(!['1','2'].includes(mode))throw Error('Choose 1 or 2. Start time unchanged.');
  }finally{prompt.close();}
  const since=parseResetTime(date,time);
  resetCheckpoint({dataDir:path.join(root,'data'),config,since,replay:mode==='2',baseQuery:process.env.GMAIL_QUERY||'in:inbox has:attachment filename:pdf'});
  console.log(`Gmail start time reset to ${date} ${time} IST.`);
  if(mode==='2')console.log('Replay is enabled for the next successful run. Previously processed attachments will be parsed again.');
  console.log('Now launch the invoice extractor and select Keep previous results.');
}
if(require.main===module)main().catch(error=>{console.error('Reset failed:',error.message);process.exitCode=1;});
module.exports={main};
