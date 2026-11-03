const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]\b/g;
function gstins(text) { return [...new Set(text.toUpperCase().match(GSTIN) || [])]; }
function validateGstin(value) {
  if (!value || !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[A-Z0-9]$/.test(value)) return false;
  const state = Number(value.slice(0, 2));
  if (!((state >= 1 && state <= 38) || state === 97 || state === 99)) return false;
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const n = alphabet.indexOf(value[i]) * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(n / 36) + n % 36;
  }
  return alphabet[(36 - total % 36) % 36] === value[14];
}
module.exports = { gstins, validateGstin };
