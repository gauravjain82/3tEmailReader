// Decimal strings at the boundaries; BigInt arithmetic internally. Never use floats for money.
function decimal(value, scale = 2) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{2,3})+)(?:\.\d+)?$/.test(raw)) return null;
  const s = raw.replace(/,/g, '');
  const [whole, fraction = ''] = s.split('.');
  if (fraction.length > scale) return null;
  return `${whole}.${fraction.padEnd(scale, '0')}`;
}
function minor(value) {
  const d = decimal(value);
  if (d == null) throw Error('Invalid monetary value');
  return BigInt(d.replace('.', ''));
}
function sum(values) { return values.reduce((a, b) => a + minor(b), 0n); }
function productMinor(quantity, rate) {
  const q = decimal(quantity, 6), r = decimal(rate, 6);
  if (q == null || r == null) throw Error('Invalid quantity/rate');
  const n = BigInt(q.replace('.', '')) * BigInt(r.replace('.', ''));
  return (n + 5000000000n) / 10000000000n;
}
function taxMinor(taxable, rate) {
  const a = decimal(taxable, 6), b = decimal(rate, 6);
  if (a == null || b == null) throw Error('Invalid tax basis/rate');
  const n = BigInt(a.replace('.', '')) * BigInt(b.replace('.', ''));
  return (n + 500000000000n) / 1000000000000n;
}
module.exports = { decimal, minor, sum, productMinor, taxMinor };
