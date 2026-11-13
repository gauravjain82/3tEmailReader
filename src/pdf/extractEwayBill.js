function extractEwayBill(text) {
  const candidates = new Set();
  for (const page of text.split(/\f|--\s*\d+\s+of\s+\d+\s*--/i)) {
    for (const label of page.matchAll(/\b(?:E[\s-]*WAY\s*BILL|EWB)\b\s*(?:Number|No\.?)?\s*[:#=-]?/gi)) {
      const tail = page.slice(label.index + label[0].length);
      const direct = tail.match(/^\s*(\d{12})(?![A-Za-z0-9])/);
      if (direct) candidates.add(direct[1]);
      // MAHLE's PDF stream separates the declaration heading from its values.
      // Require its known heading, vendor and a standalone number/date row.
      else if (/MAHLE ENGINE COMPONENTS INDIA/i.test(page) && /^\s*Date[ \t]*\r?\n/i.test(tail)) {
        for (const row of tail.matchAll(/(?:^|\n)[ \t]*(\d{12})[ \t]+\d{2}-[A-Z]{3}-(?:\d{4}|\d{2})(?=\s|$)/gi)) candidates.add(row[1]);
      }
    }
  }
  const ewayBillCandidates = [...candidates];
  return { ewayBillNumber: ewayBillCandidates.length === 1 ? ewayBillCandidates[0] : null, ewayBillCandidates };
}

module.exports = { extractEwayBill };
