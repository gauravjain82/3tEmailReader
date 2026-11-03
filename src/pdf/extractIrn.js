function extractIrn(text) {
  const candidates=new Set();
  for (const label of text.matchAll(/\bIRN\b\s*(?:No\.?|Number)?\s*[:#-]?/gi)) {
    let tail=text.slice(label.index+label[0].length),value='';
    // Some layouts wrap the reference across several lines. Accept hex tokens only.
    while (value.length<64) {
      const token=tail.match(/^\s*([A-Fa-f0-9]+)(?=$|[^A-Za-z0-9])/);
      if (!token) break;
      value+=token[1];tail=tail.slice(token[0].length);
    }
    if (/^[a-f0-9]{64}$/i.test(value)) candidates.add(value.toLowerCase());
  }
  const irnCandidates=[...candidates];
  return {irn:irnCandidates.length===1?irnCandidates[0]:null,irnCandidates};
}
module.exports = { extractIrn };
