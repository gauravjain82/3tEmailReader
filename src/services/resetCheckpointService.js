const crypto=require('crypto');
const {validateConfig}=require('../config');
const {validDate}=require('../pdf/validators/invoiceValidator');
const {openStore}=require('../storage/store');
const {checkpointKey,acquireRunLock}=require('./runOnceService');

function parseResetTime(date,time,now=Date.now()) {
  const match=/^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
  if(!match)throw Error('Enter the date as DD-MM-YYYY, for example 06-11-2026.');
  const isoDate=`${match[3]}-${match[2]}-${match[1]}`;
  if(!validDate(isoDate))throw Error('Enter a valid calendar date.');
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))throw Error('Enter a 24-hour time as HH:MM, for example 06:00 or 18:30.');
  const since=Date.parse(`${isoDate}T${time}:00+05:30`)/1000;
  if(!Number.isSafeInteger(since)||since<0||since>Math.floor(now/1000))throw Error('Reset time must be after 1970 and cannot be in the future.');
  return since;
}
function resetCheckpoint({dataDir,config,baseQuery='in:inbox has:attachment filename:pdf',since,replay=false,now=Date.now()}) {
  config=validateConfig(config);
  if(!Number.isSafeInteger(since)||since<0||since>Math.floor(now/1000))throw Error('Invalid reset timestamp or future time.');
  const unlock=acquireRunLock(dataDir);let store;
  try {
    store=openStore(dataDir);
    const key=checkpointKey(config,baseQuery),resetAt=new Date(now).toISOString();
    return store.db.transaction(()=>{
      const previous=store.db.prepare('SELECT value FROM app_state WHERE key=?').get(key)?.value ?? null;
      const value=JSON.stringify(replay ? {since,replay:true} : {since});
      const historyKey='gmail-reset-history:'+crypto.randomUUID();
      store.db.prepare('INSERT INTO app_state(key,value) VALUES (?,?)').run(historyKey,JSON.stringify({checkpointKey:key,previousValue:previous,newValue:value,resetAt}));
      store.db.prepare('INSERT INTO app_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
      return {since,replay,resetAt,historyKey,senders:config.allowedSenders};
    }).immediate();
  } finally {if(store)store.close();unlock();}
}
module.exports={parseResetTime,resetCheckpoint};
