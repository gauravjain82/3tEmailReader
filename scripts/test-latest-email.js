require('dotenv').config({quiet:true});
const {gmail,root}=require('../src/common');
const {loadConfig}=require('../src/config');
const {testLatestEmails}=require('../src/services/latestEmailTestService');
(async()=>{
  if(process.argv.length>2)throw Error('Usage: npm run test:email (senders come only from config.json)');
  const config=loadConfig(root);
  const report=await testLatestEmails({api:gmail(),projectRoot:root,config});
  if(report.hasIssues){console.log('Test completed with issues. Review test-report.json and failure-report.csv in the displayed folder.');process.exitCode=1;}
})().catch(error=>{console.error('Email test failed:',error.message);process.exitCode=1;});
