const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { senderAddress, validateConfig } = require('../config');
const { processMessage, withRetry } = require('../gmail/processMessage');

function acquireRunLock(dataDir) {
  fs.mkdirSync(dataDir,{recursive:true});
  const file = path.join(dataDir,'extractor.lock');
  const token = crypto.randomUUID();
  for (let attempt=0;attempt<2;attempt++) {
    try {
      const fd = fs.openSync(file,'wx');
      try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token})); } finally { fs.closeSync(fd); }
      return () => { if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file,'utf8')).token === token) fs.unlinkSync(file); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw Error('Extractor lock is unreadable. Check that no extractor is running before removing data/extractor.lock.'); }
      if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw Error('Invalid extractor lock. Check data/extractor.lock.');
      try { process.kill(previous.pid,0); }
      catch (error) { if (error.code === 'ESRCH') { fs.unlinkSync(file); continue; } throw error; }
      throw Error('An invoice extraction run is already active. Wait for its window to finish.');
    }
  }
  throw Error('Could not acquire the extractor run lock.');
}
function checkpointKey(config, baseQuery) {
  return 'gmail-run:' + crypto.createHash('sha256').update(JSON.stringify({senders:config.allowedSenders,baseQuery})).digest('hex');
}
function initialSince(store, config) {
  if (config.firstRunAfter != null) return config.firstRunAfter;
  // Bootstrap upgraded installations from the last received message, never from reprocessing time.
  let latest = 0;
  for (const row of store.db.prepare('SELECT sender,received_at FROM invoices WHERE received_at IS NOT NULL').all()) {
    if (config.allowedSenders.includes(senderAddress(row.sender))) {
      const seconds = Math.floor(Date.parse(row.received_at)/1000);
      if (Number.isFinite(seconds)) latest = Math.max(latest,seconds);
    }
  }
  return latest;
}
function buildQuery(baseQuery, senders, since, until) {
  return `(${baseQuery}) {${senders.map(s=>'from:'+s).join(' ')}} after:${Math.max(0,since-1)} before:${until}`;
}
async function runOnce({api,store,dataDir,config,baseQuery='in:inbox has:attachment filename:pdf',pageSize=50,now=()=>Date.now(),handleMessage=processMessage}) {
  config = validateConfig(config);
  const key = checkpointKey(config,baseQuery);
  const until = Math.floor(now()/1000);
  let checkpoint = store.db.prepare('SELECT value FROM app_state WHERE key=?').get(key);
  if (!checkpoint) {
    const since = initialSince(store,config);
    if (since > until) throw Error('The initial start date is in the future. Check config.json and the system clock.');
    store.db.prepare('INSERT INTO app_state(key,value) VALUES (?,?)').run(key,JSON.stringify({since}));
    checkpoint = store.db.prepare('SELECT value FROM app_state WHERE key=?').get(key);
  }
  const {since} = JSON.parse(checkpoint.value);
  if (!Number.isSafeInteger(since) || since < 0 || since > until) throw Error('Invalid saved run checkpoint or system clock.');
  const query = buildQuery(baseQuery,config.allowedSenders,since,until);
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
        const result = await handleMessage(api,message.id,store,dataDir,{allowedSenders:config.allowedSenders,exportAfter:false});
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
  store.db.prepare('UPDATE app_state SET value=? WHERE key=?').run(JSON.stringify({since:until,lastSuccessfulRun:new Date(now()).toISOString()}),key);
  console.log('Run complete:',JSON.stringify(summary));
  return summary;
}
module.exports = { runOnce, acquireRunLock, checkpointKey, buildQuery, initialSince };
