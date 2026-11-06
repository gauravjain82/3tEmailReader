const path = require('path');
const crypto = require('crypto');
const { validateConfig } = require('../config');
const { processMessage, withRetry } = require('../gmail/processMessage');
const { atomicWrite } = require('../storage/store');
const { acquireRunLock } = require('./runLock');
function checkpointKey(config, baseQuery) {
  return 'gmail-run:' + crypto.createHash('sha256').update(JSON.stringify({senders:config.allowedSenders,baseQuery})).digest('hex');
}
function initialSince(store, config, until=Math.floor(Date.now()/1000)) {
  if (config.firstRunAfter != null) return config.firstRunAfter;
  // Only the first run uses this rolling window. Persist it before processing
  // so failures/retries never slide the boundary forward and miss older mail.
  return Math.max(0,until-24*60*60);
}
function buildQuery(baseQuery, senders, since, until) {
  return `(${baseQuery}) {${senders.map(s=>'from:'+s).join(' ')}} after:${Math.max(0,since-1)} before:${until}`;
}
function ensureCheckpoint(store, config, baseQuery, until) {
  const key = checkpointKey(config,baseQuery);
  let checkpoint = store.db.prepare('SELECT value FROM app_state WHERE key=?').get(key);
  if (!checkpoint) {
    const since = initialSince(store,config,until);
    if (since > until) throw Error('The initial start date is in the future. Check config.json and the system clock.');
    store.db.prepare('INSERT INTO app_state(key,value) VALUES (?,?)').run(key,JSON.stringify({since}));
    checkpoint = store.db.prepare('SELECT value FROM app_state WHERE key=?').get(key);
  }
  const {since} = JSON.parse(checkpoint.value);
  if (!Number.isSafeInteger(since) || since < 0 || since > until) throw Error('Invalid saved run checkpoint or system clock.');
  return {key,since};
}
async function runOnce({api,store,dataDir,config,baseQuery='in:inbox has:attachment filename:pdf',pageSize=50,now=()=>Date.now(),handleMessage=processMessage}) {
  config = validateConfig(config);
  const until = Math.floor(now()/1000);
  const {key,since} = ensureCheckpoint(store,config,baseQuery,until);
  const pending = JSON.parse(store.db.prepare('SELECT value FROM app_state WHERE key=?').get(key).value);
  const runId = pending.pendingRunId || crypto.randomUUID();
  store.db.prepare('UPDATE app_state SET value=? WHERE key=?').run(JSON.stringify({...pending,pendingRunId:runId}),key);
  const query = buildQuery(baseQuery,config.allowedSenders,since,until);
  if(pending.replay)console.log('Replay enabled: reprocessing matching emails, including previously processed attachments. Invoice-number duplicates and print history are retained.');
  const summary = { messagesChecked:0, skippedSenders:0, failedMessages:0, since, until };
  console.log('Reading configured senders once. Window:',new Date(since*1000).toISOString(),'to',new Date(until*1000).toISOString());
  let pageToken;
  const seen = new Set();
  const pageTokens = new Set();
  do {
    const response = await withRetry(()=>api.users.messages.list({userId:'me',q:query,maxResults:Math.min(100,Math.max(1,Number(pageSize)||50)),pageToken}));
    for (const message of response.data.messages || []) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      try {
        const result = await handleMessage(api,message.id,store,dataDir,{allowedSenders:config.allowedSenders,invoiceNumberFilenameSenders:config.invoiceNumberFilenameSenders,reprocessCompleted:pending.replay===true,exportAfter:false,runId});
        if (result?.failed) summary.failedMessages++;
        if (result?.skippedSender) summary.skippedSenders++;
      } catch (e) { summary.failedMessages++; console.error('Message error:',message.id,e.message); }
      summary.messagesChecked++;
    }
    pageToken = response.data.nextPageToken;
    if (pageToken && pageTokens.has(pageToken)) throw Error('Gmail returned a repeated pagination token. Checkpoint was not advanced.');
    if (pageToken) pageTokens.add(pageToken);
  } while (pageToken);
  store.exportAll();
  if (summary.failedMessages) throw Error(`${summary.failedMessages} message(s) failed. The checkpoint was not advanced; double-click the CMD file again to retry.`);
  summary.runId = runId;
  summary.invoiceIds = store.db.prepare("SELECT id FROM invoices WHERE source_run_id=? AND duplicate_of IS NULL AND document_type='TAX_INVOICE' AND normalized_invoice_number IS NOT NULL AND validation_status IN ('VALIDATED','NEEDS_REVIEW') ORDER BY id").all(runId).map(r=>r.id);
  atomicWrite(path.join(dataDir,'last-run-invoices.json'),JSON.stringify({runId,invoiceIds:summary.invoiceIds,completedAt:new Date(now()).toISOString()},null,2));
  store.db.prepare('UPDATE app_state SET value=? WHERE key=?').run(JSON.stringify({since:until,lastSuccessfulRun:new Date(now()).toISOString()}),key);
  console.log('Run complete:',JSON.stringify(summary));
  return summary;
}
module.exports = { runOnce, acquireRunLock, checkpointKey, buildQuery, initialSince, ensureCheckpoint };
