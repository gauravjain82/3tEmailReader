const fs = require('fs');
const path = require('path');
const EMAIL = /^[A-Z0-9._%+-]+@(?:[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?\.)+[A-Z]{2,}$/i;
function senderAddress(header) {
  const text = String(header || '').trim();
  const address = text.includes('<') ? text.match(/^[^<>]*<([^<>]+)>\s*$/)?.[1]?.trim() : text;
  return address && EMAIL.test(address) ? address.toLowerCase() : null;
}
function validateConfig(config) {
  if (!Array.isArray(config.allowedSenders) || !config.allowedSenders.length) throw Error('Add at least one sender email address to allowedSenders in config.json.');
  const allowedSenders = [...new Set(config.allowedSenders.map(value => {
    if (typeof value !== 'string' || !EMAIL.test(value.trim())) throw Error('allowedSenders must contain complete email addresses, without display names or wildcards.');
    return value.trim().toLowerCase();
  }))].sort();
  let firstRunAfter = null;
  if (config.firstRunAfter != null) {
    if (typeof config.firstRunAfter !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(config.firstRunAfter) || !require('./pdf/validators/invoiceValidator').validDate(config.firstRunAfter.slice(0,10)) || !Number.isFinite(Date.parse(config.firstRunAfter))) throw Error('firstRunAfter must be null or an ISO timestamp with timezone, e.g. 2026-11-01T00:00:00+05:30.');
    firstRunAfter = Math.floor(Date.parse(config.firstRunAfter) / 1000);
    if (firstRunAfter < 0) throw Error('firstRunAfter must be after 1970.');
  }
  return { allowedSenders, firstRunAfter };
}
function loadConfig(root) { const config = JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8')); validateConfig(config); return config; }
module.exports = { loadConfig, validateConfig, senderAddress };
