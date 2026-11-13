const DEFAULT_GMAIL_QUERY = 'in:inbox has:attachment {filename:pdf filename:zip}';
const isZip = part => /\.zip$/i.test(part.filename || '') || /^(?:application\/(?:zip|x-zip|x-zip-compressed))$/i.test(part.mimeType || '');
const isPdf = part => /\.pdf$/i.test(part.filename || '') || part.mimeType === 'application/pdf';
const isSupportedAttachment = part => isZip(part) || isPdf(part);
// Existing installations keep their .env; expand the old PDF-only filter too.
function includeZipAttachments(query) {
  return query.replace(/\{filename:pdf filename:zip\}/gi, 'filename:pdf').replace(/(^|[\s({])filename:pdf(?=$|[\s)}])/gi, (_, prefix) => prefix+'{filename:pdf filename:zip}');
}
function checkpointQuery(query) {
  return query.replace(/\{filename:pdf filename:zip\}/gi, 'filename:pdf');
}
module.exports = { DEFAULT_GMAIL_QUERY, isZip, isPdf, isSupportedAttachment, includeZipAttachments, checkpointQuery };
