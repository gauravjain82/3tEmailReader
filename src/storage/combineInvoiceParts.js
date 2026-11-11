const { decimal } = require('../pdf/decimal');

function add(values, scale) {
  const normalized = values.map(value => decimal(value, scale));
  if (normalized.some(value => value === null)) return null;
  const total = normalized.reduce((sum, value) => sum + BigInt(value.replace('.', '')), 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
  return `${total < 0n ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

// Call once per invoice. Keep source line items intact for validation and audit.
function combineInvoiceParts(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.part_number || Symbol('unknown part');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map(group => group.length === 1 ? group[0] : {
    part_number: group[0].part_number,
    quantity: add(group.map(item => item.quantity), 6),
    taxable_amount: add(group.map(item => item.taxable_amount), 2)
  });
}

module.exports = { combineInvoiceParts };
