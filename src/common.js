const fs=require('fs');const path=require('path');const {google}=require('googleapis');
const root=path.resolve(__dirname,'..');
function oauth(){const p=path.join(root,'credentials.json');if(!fs.existsSync(p))throw Error('Missing credentials.json. See README.');const data=JSON.parse(fs.readFileSync(p,'utf8'));const c=data.installed||data.web;if(!c)throw Error('Expected Google OAuth Desktop client credentials');return new google.auth.OAuth2(c.client_id,c.client_secret,'http://localhost');}
function gmail(){const client=oauth();const tokenPath=path.join(root,'token.json');if(!fs.existsSync(tokenPath))throw Error('Run npm run auth first');client.setCredentials(JSON.parse(fs.readFileSync(tokenPath,'utf8')));client.on('tokens',tokens=>{const old=JSON.parse(fs.readFileSync(tokenPath,'utf8'));fs.writeFileSync(tokenPath,JSON.stringify({...old,...tokens},null,2),{mode:0o600});});return google.gmail({version:'v1',auth:client});}
function gmailErrorMessage(error){
  const code=error?.response?.data?.error;
  if(code==='invalid_grant'||/\binvalid_grant\b/.test(error?.message||''))return 'Gmail authorization has expired or been revoked (invalid_grant). Double-click Reconnect Gmail.cmd or run npm run auth, sign in to your Gmail account, then retry. Google OAuth apps in Testing can require reauthorization after 7 days. Reconnecting keeps your saved invoices and email checkpoint.';
  return error?.message||String(error);
}
module.exports={root,oauth,gmail,gmailErrorMessage};
