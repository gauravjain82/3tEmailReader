require('dotenv').config({quiet:true});
const {gmail,root}=require('../src/common');
const {loadConfig}=require('../src/config');
const {testLatestEmails}=require('../src/services/latestEmailTestService');
const readline=require('node:readline/promises');
(async()=>{
  const args=process.argv.slice(2);
  if(args.some(arg=>!['--print','--no-print','--choose'].includes(arg))||new Set(args).size!==args.length||args.includes('--print')&&args.includes('--no-print'))throw Error('Usage: npm run test:email -- [--print | --no-print | --choose] (senders come only from config.json)');
  const config=loadConfig(root);
  const choosePrint=!args.includes('--print')&&!args.includes('--no-print')&&(process.stdin.isTTY||args.includes('--choose'))?async count=>{
    const prompt=readline.createInterface({input:process.stdin,output:process.stdout});
    try {return /^y(?:es)?$/i.test((await prompt.question(`Print the first original page of ${count} unique test invoice(s) through SumatraPDF? [y/N]: `)).trim());}finally{prompt.close();}
  }:undefined;
  const report=await testLatestEmails({api:gmail(),projectRoot:root,config,print:args.includes('--print'),choosePrint});
  if(report.hasIssues){console.log('Test completed with issues. Review test-report.json and failure-report.csv in the displayed folder.');process.exitCode=1;}
})().catch(error=>{console.error('Email test failed:',error.message);process.exitCode=1;});
