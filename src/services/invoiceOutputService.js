const fs = require('fs');
const path = require('path');
const readline = require('node:readline/promises');
const { saveOriginalInvoices } = require('./originalInvoiceService');
const { printOriginalInvoices } = require('./printService');
const { atomicWrite } = require('../storage/store');

async function chooseInvoiceAction(count,{interactive=Boolean(process.stdin.isTTY),ask}={}) {
  if (!count || !interactive && !ask) return 'none';
  console.log(`\n${count} unique invoice(s) from this run:`);
  console.log('  1. Finish (default)');
  console.log('  2. Save original invoice PDFs only');
  console.log("  3. Print original invoices on this PC's default printer");
  console.log('  4. Save and print originals');
  const prompt=ask ? null : readline.createInterface({input:process.stdin,output:process.stdout});
  try {
    while (true) {
      const answer=String(await (ask ? ask('Select [1/2/3/4], Enter for 1: ') : prompt.question('Select [1/2/3/4], Enter for 1: '))).trim();
      if (!answer || answer==='1') return 'none';
      if (answer==='2') return 'save';
      if (answer==='3') return 'print';
      if (answer==='4') return 'both';
      console.log('Enter 1, 2, 3 or 4.');
    }
  } finally { prompt?.close(); }
}
async function outputRunInvoices(store,dataDir,selection,action) {
  if (action==='none') return null;
  if (!['save','print','both'].includes(action)) throw Error('Unknown invoice action');
  const report=await saveOriginalInvoices(store,dataDir,selection);
  console.log('Invoice PDFs:',report.outputDir);
  console.log('Saved unique invoices:',report.invoices.length);
  if(report.invoices.some(i=>i.signedOriginalPreserved))console.log('Signed attachments are kept intact. Printing uses only the first original-recipient page.');
  for (const item of report.skipped) console.error('Original skipped:',item.invoiceNumber,item.reason);
  if (['print','both'].includes(action) && report.invoices.length) {
    if(process.env.PRINT_ENGINE==='adobe')console.log('Adobe desktop printing: close existing Reader windows first. Keep the desktop unlocked and avoid using the mouse/keyboard while the dialog is being set.');
    let printed;
    try { printed=await printOriginalInvoices(store,report.invoices); }
    finally { store.exportAll(); }
    atomicWrite(path.join(report.outputDir,'print-result.json'),JSON.stringify(printed,null,2));
    console.log('Printer submissions:',printed.submitted.length,'signature blocked:',printed.blocked.length,'already submitted:',printed.skipped.length,'uncertain:',printed.uncertain.length,'failed:',printed.failed.length);
    if(printed.unattempted?.length)console.error('Adobe automation stopped. Remaining invoices were not opened or printed:',printed.unattempted.length);
    for (const blocked of printed.blocked) console.error('Signature review:',blocked.invoiceNumber,blocked.status,blocked.reason);
    if (printed.uncertain.length) console.error('Check the Windows printer queue for uncertain jobs before printing them manually. They will not be automatically resubmitted.');
    if (printed.failed.length) console.error('Some PDFs could not be submitted; see print-result.json.');
    if (printed.failed.length || printed.uncertain.length || printed.blocked.length) process.exitCode=1;
  }
  return report;
}
async function main() {
  require('dotenv').config();
  const {root}=require('../common');
  const {openStore}=require('../storage/store');
  const {acquireRunLock}=require('./runOnceService');
  const args=process.argv.slice(2);
  if (args.length>1 || args.some(a=>!['--save','--print','--both','--choose'].includes(a))) throw Error('Usage: npm run originals -- [--save | --print | --both | --choose]');
  const dataDir=path.join(root,'data');
  const release=acquireRunLock(dataDir);
  let store;
  try {
    const selectionPath=path.join(dataDir,'last-run-invoices.json');
    if (!fs.existsSync(selectionPath)) throw Error('Run Invoice Extractor.cmd once first; no completed batch is available to save or print.');
    const selection=JSON.parse(fs.readFileSync(selectionPath,'utf8'));
    const action=args[0] && args[0]!=='--choose' ? args[0].slice(2) : await chooseInvoiceAction(selection.invoiceIds.length,{interactive:process.stdin.isTTY || args[0]==='--choose'});
    if (action==='none') return;
    store=openStore(dataDir);
    await outputRunInvoices(store,dataDir,selection,action);
  } finally { store?.close();release(); }
}
if (require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports = { chooseInvoiceAction, outputRunInvoices };
