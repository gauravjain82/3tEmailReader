# Gmail PDF Extractor (Node.js)

Runs once when you double-click `Run Invoice Extractor.cmd`: reads new Gmail PDF attachments from configured senders, extracts invoices, and writes JSON, CSV and SQLite. It exits after the batch; there is no background polling. No Gmail password required.

## Prerequisites
- Node.js 20 or 22 (recommended: Node.js 22 LTS) and npm
- A Google Cloud project with **Gmail API enabled**
- An OAuth consent screen configured, with your Gmail account added as a test user if the app is in testing mode
- An **OAuth client ID** of type **Desktop app** (not service account)

## Setup (PowerShell)
1. In Google Cloud Console: APIs & Services > Library > enable Gmail API.
2. Configure Google Auth Platform / OAuth consent screen; select appropriate audience and scopes. Add `https://www.googleapis.com/auth/gmail.readonly` as a scope. For an external app in testing, add your Gmail address as a test user.
3. Create OAuth client: **Desktop app**. Download its JSON and rename it to `credentials.json` in this project directory.
4. Run:

```powershell
cd C:\GmailPdfExtractor
npm install
Copy-Item .env.example .env
npm run auth
```

Open the printed Google authorization URL on the same Windows machine. Grant read-only Gmail permission. It saves `token.json` locally. Configure sender addresses in `config.json` (copy `config.example.json` if needed). Then double-click **Run Invoice Extractor.cmd**, or run:

```powershell
npm start
```

**Security:** Keep `credentials.json`, `token.json`, `.env` and the `data` folder private. Never commit them to Git. Token refresh behavior for apps in Google OAuth **Testing** status may require periodic reauthorization (often after 7 days for external testing apps). For ongoing production use, configure an appropriate published OAuth app and follow Google's verification requirements.

## Filtering
Edit `config.json` to list the exact sender email addresses you want to process:

```json
{
  "allowedSenders": ["billing@example.com", "invoices@example.com"],
  "firstRunAfter": null
}
```

Addresses are matched without regard to letter case. Gmail search filters reduce fetched messages, and the actual `From` mailbox is checked again before downloading PDFs. Display names and wildcard/domain patterns are not treated as configured addresses. An empty list stops the run. `config.json` is ignored by Git to keep real sender addresses local.

The first run on this upgraded installation starts at the latest stored Gmail receipt time for the configured senders. It does not use local PDF reprocessing times. If no matching stored receipt time exists, the first run searches all matching inbox PDFs. To choose the initial starting point explicitly, set `firstRunAfter` to an ISO timestamp with a timezone, such as `2026-11-01T00:00:00+05:30`, before the first run for that sender configuration.

After each successful batch, SQLite saves the completed time window. The next double-click processes emails received since that window, with a one-second overlap protected by attachment and invoice-number duplicate checks. The run freezes its upper boundary at startup, so mail arriving during the run is picked up next time. Failed downloads, PDF extraction errors, API failures or export errors leave the checkpoint unchanged; double-click again to retry. `NEEDS_REVIEW` is a completed extraction requiring human review, so it does not block the checkpoint.

Sender configurations have separate checkpoints. Changing `firstRunAfter` does not rewind an existing checkpoint. For old files already recorded in SQLite, use `npm run reprocess`.

Optional `.env` settings add further Gmail restrictions; sender and time-window filters always apply:

```ini
GMAIL_QUERY=in:inbox has:attachment filename:pdf
PAGE_SIZE=50
```

Every result page is processed. `POLL_SECONDS` and `MAX_MESSAGES_PER_POLL` are no longer used. The date window uses epoch seconds to avoid Gmail's timezone interpretation of date-only search terms; see [Google's filtering guide](https://developers.google.com/workspace/gmail/api/guides/filtering).

## Output
- `data/pdfs/`: original downloaded PDFs
- `data/json/`: one JSON document per attachment
- `data/invoices.csv`: main export, excluding repeated invoice numbers
- `data/duplicates.csv`: historical and newly detected duplicates with links to their original invoice records
- `data/invoices.db`: SQLite database, tables `invoices` and `attachments`

The `attachments` table tracks download/extraction attempts. Failed attachments are retried on the next manual run; a retained local PDF is reused. `done` means the processing attempt completed; check `validation_status` before using any record for accounting. Never delete tracking rows to reprocess files. Use the local command below.

## Invoice-number duplicate checks

Tax invoices are compared by invoice number across all senders and emails, after trimming outside whitespace and converting letters to uppercase. Separators and leading zeros remain significant: `INV/001` and `INV-001`, or `001` and `1`, are different numbers. Missing/malformed numbers are left for review rather than grouped together. Bin tags and other non-invoice documents do not participate.

New attachments with an existing invoice number are downloaded and retained, but no extra invoice row or line items are inserted. Their Gmail metadata, full extraction result and original-invoice link are stored in `duplicate_attachments`, exported as JSON with `isDuplicate`/`duplicateOf`, and listed in `duplicates.csv`. The original invoice is not overwritten.

The migration preserves historical invoice rows and IDs, marks repeat numbers with `duplicate_of`, and excludes them from the main CSV. It chooses an existing validated record first, otherwise a review record, otherwise the earliest available record. Subsequent runs keep that canonical record stable. An `invoice_numbers` table enforces a single canonical record per normalized number transactionally. Duplicate-number matching is global, including if suppliers reuse the same number; review the separate duplicates export in those cases.

## Limitations and production notes
- FST and Motherson/HUB layouts have dedicated parsers checked against local PDFs. Other layouts use a conservative generic fallback and require review. Astemo samples currently use that fallback; their line-item tables and party roles need a dedicated parser.
- Image-only/scanned PDFs are marked failed: integrate OCR for these. Password-protected PDFs may also fail.
- No messages are deleted, labeled, or marked read. The app requests Gmail **read-only** scope.
- JSON and CSV are regenerated from committed SQLite data at the end of each batch. Export errors (for example, a CSV locked by Excel) do not invalidate committed extractions or advance the checkpoint. Close the locking application and launch again to recover exports.
- SQLite works for a single worker. For multi-instance processing, migrate to PostgreSQL with transactional job claiming.
- The CMD launcher keeps its window open after completion so you can read the result. `npm start` performs the same single batch and exits. A process lock prevents overlapping manual launches; stale locks from terminated processes are recovered on the next launch.
- The PDF parser and dependencies process untrusted attachments: use a dedicated restricted account and keep packages updated.

## Extraction pipeline and source layout

The original flow lived in `src/index.js`: enumerate Gmail messages, download each PDF, run generic regexes, write JSON and SQLite, then regenerate CSV. Inspection found labels accepted as identifiers, missed dotted dates, unassigned GSTIN roles, and no line-item validation. Local database inspection also found repeated rows for the same message/PDF under changing Gmail download attachment IDs.

The revised flow is:

1. `src/services/runOnceService.js` enumerates the configured sender/time window once and saves the checkpoint on success. `src/gmail/processMessage.js` verifies senders, downloads attachments and tracks stable MIME part identities. Existing records are recognized through the original message/index PDF filename prefix. Original Gmail download attachment IDs are also retained. Invoice-number duplicates retain their separate provenance without adding invoices. Historical duplicate rows are preserved.
2. `src/pdf/extractText.js` extracts text with `pdf-parse` and always destroys the parser.
3. `detectDocumentType.js` classifies content as `TAX_INVOICE`, `BIN_TAG`, `COLOUR_CODE_DOCUMENT`, `OTHER`, or `UNKNOWN`. Consignment/unload-card layouts identify the local colour-code documents. Filenames do not determine classification.
4. `parserRegistry.js` chooses FST, Motherson/HUB, or generic parsing. Vendor parsers use observed header/table layouts, handle multiple rows, and avoid counting identical recipient/transporter copies as additional goods. Names and GSTIN roles come from the bill-to/seller regions.
5. `validators/` checks identifiers, calendar dates, GSTIN structure/state/checksum, required party fields, line-item identity, quantity × unit price, tax rates, line/header sums, and grand total reconciliation. A checksum does not establish that a GST registration is active; no external registration lookup is performed.
6. `src/storage/store.js` commits invoice headers, items, validation and extraction history transactionally, then generates exports. `src/services/` coordinates extraction and local reprocessing. `auth.js` and `common.js` are unchanged, including OAuth scope and refresh-token handling.

## Validation and money

| Status | Meaning |
| --- | --- |
| `VALIDATED` | All implemented checks passed for the supported layout. This is extraction validation, not accounting approval. |
| `NEEDS_REVIEW` | Missing/ambiguous fields, unsupported layout, conflicting copies, retained previous fields, or failed reconciliation. |
| `FAILED` | PDF read, hash verification, or text extraction failed. Original files and prior values are retained. |
| `NOT_APPLICABLE` | Recognized logistics or other non-invoice document. |

Each result includes explicit `validation.issues`, `validation.checks`, parser name/version, classification basis and extraction evidence. No numerical confidence scores are invented. Unknown documents require review. Non-invoice documents are classified without applying invoice regexes.

New monetary fields are canonical decimal **strings**, stored as SQLite `TEXT` and exported as strings in JSON. Arithmetic uses scaled `BigInt`; no monetary calculations use floating-point numbers. Quantities and unit prices retain up to six decimal places. Grand totals and header/item sums must reconcile exactly; rate-derived values allow one paisa for rounding. Observed FST PDFs with whole-rupee rounding or quantity/rate differences remain flagged for review. Discounts, non-unit pricing bases, extra charges and unrecognized rounding conventions require further layout-specific rules.

Existing main CSV columns remain first, followed by party/header fields, document type, validation, parser/version, reprocessing time, source attachment identifiers, normalized invoice number, duplicate reference and `line_items_json`. Formula-like CSV cells are escaped for spreadsheet safety. JSON retains the original camelCase metadata/field names and adds `lineItems`, roles, validation and duplicate indicators.

## SQLite migration and recovery

Migrations are additive, transactional and idempotent. Write transactions reserve the SQLite writer before reading to avoid stale-snapshot lock failures in WAL mode. Existing invoice IDs and `(gmail_id, attachment_key)` identities are preserved; upserts do not use `INSERT OR REPLACE`. Tables include `invoice_line_items`, `extraction_runs`, `schema_migrations`, `invoice_numbers`, `duplicate_attachments` and `app_state`; `invoices` receives additional nullable columns. Legacy rows remain unreviewed until reprocessed. Legacy monetary strings are kept until a new extraction supplies normalized values. The first manual launch creates a consistent SQLite backup before the invoice-number migration.

Each invoice extraction attempt records its candidate and saved result in `extraction_runs`; new duplicate attachment results have their own audit record. The first reprocessing also archives the legacy row. Empty new fields do not erase prior values: retained fields are listed explicitly in validation issues, and invoice results require review. Failed reprocessing preserves prior line items and invoice-number identity. New exports use distinct paths when historical duplicate rows shared a JSON filename. SQLite remains authoritative if an export is interrupted; exports are written through temporary files and recovered on the next run.

## Reprocess downloaded PDFs

Wait for any active CMD batch to finish before upgrading or reprocessing live data. Run only one worker/reprocessing command at a time. Then:

```powershell
npm test
npm run reprocess
npm start
```

`reprocess` needs no Gmail authentication or network calls. It first creates a consistent SQLite backup (including WAL transactions) under `data/backups/`, then migrates and reprocesses stored invoice records using their local PDF paths. It verifies SHA-256 against the download, preserves original Gmail metadata and first processing time, records `reprocessed_at` and parser version, and updates rows/items without creating duplicate invoices. Available legacy `receivedAt` metadata is recovered from JSON before export. Missing/unreadable/tampered PDFs become `FAILED`. Historical duplicate records are updated individually and retained; this command does not merge or delete them.

Optional exact-match filters apply to stored values before reprocessing:

```powershell
npm run reprocess -- --document-type TAX_INVOICE
npm run reprocess -- --status NEEDS_REVIEW
npm run reprocess -- --filename 800450413.pdf
```

Use unfiltered reprocessing first: legacy records have no document type/status. Filters may be combined. Files that were never recorded in SQLite are not automatically imported because Gmail provenance cannot be inferred safely.

## Tests and local verification

`npm test` uses Node's built-in test runner with isolated temporary databases. It covers classification, identifiers, GSTIN checks, vendor codes, line items/copy deduplication, malformed fields, exact arithmetic, migrations, metadata preservation, repeated reprocessing, tampered files, export recovery, quota retries, stable attachment tracking, invoice-number duplicate prevention, exact sender filtering, pagination, single-run checkpoints, failed-run recovery and overlapping launch prevention. Real local FST, HUB, bin-tag and colour-code PDFs are used when available; those cases explicitly skip when PDFs are absent. No credentials or Gmail calls are needed.

```powershell
npm run verify:local
```

This creates a consistent copy of the live database under `data/verification/<timestamp>/`, migrates it, reprocesses it twice, checks IDs/metadata and SQLite integrity, and exports JSON/CSV plus `report.json`. All export paths are redirected into that directory. Live database records, PDFs and exports are unchanged. The report includes example extractions and validation reasons for every unique PDF.

Confirmed examples from local PDF text:

| PDF | Invoice | ISO date | Vendor | Customer part | Grand total |
| --- | --- | --- | --- | --- | --- |
| `800450413.pdf` | `DS0003468303` | `2026-11-03` | `X209` | `12934M74L00` | `57112.00` |
| `23_12627110031_1.pdf` | `12627110031` | `2026-10-21` | `T460` | `24413M68P40` | `6890.26` |

The FST sample reconciles `48400.00 + 4356.00 + 4356.00`; the HUB sample reconciles `5839.20 + 1051.06`. Both pass implemented validation. New supplier layouts and scanned PDFs still require additional parsers or a separately approved OCR integration. No paid services or OCR dependencies were added.
