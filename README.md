# Gmail PDF Extractor (Node.js)

Runs once when you double-click `Run Invoice Extractor.cmd`: reads new Gmail PDFs attached directly or inside ZIP attachments from configured senders, extracts invoices, and writes JSON, CSV and SQLite. It exits after the batch; there is no background polling. No Gmail password required.

**New PC:** follow [SETUP.md](SETUP.md), then double-click **Setup.cmd** for guided installation/configuration and machine checks. Existing settings and invoice data are retained. To check readiness without installing anything, run `npm run setup:check`.

**Local rejection invoices:** double-click **Parse Rejection Invoices.cmd** to parse PDFs placed in `rejections/input` and create a separate CSV retaining the 14 MF02 template columns. Windows OCR and Tesseract compare every PDF field; differences are listed in `discrepancy-report.csv`. See [REJECTIONS.md](REJECTIONS.md) for field meanings, review and output locations. This workflow runs independently of Gmail.

## Prerequisites
- Node.js 22.x or 24.x and npm. SQLite is pinned to `better-sqlite3` 12.11.1, which supports both versions. Node 24 does not require downgrading for this project.
- A Google Cloud project with **Gmail API enabled**
- An OAuth consent screen configured, with your Gmail account added as a test user if the app is in testing mode
- An **OAuth client ID** of type **Desktop app** (not service account)

If an older checkout reports `node-gyp` / `find VS` while installing on Node 24, its `better-sqlite3` 11.x dependency lacks a matching prebuilt binary. Update with `npm install better-sqlite3@12.11.1 --save-exact`, or use the updated project lockfile with `npm ci`. A clean Windows x64 installation and all automated tests were verified on Node 24.22.1 as well as Node 22.16.0. Visual Studio Build Tools are needed only if a suitable prebuilt binary cannot be downloaded and npm must compile from source; VS Code does not supply that compiler.

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

## Gmail error: invalid_grant

Google has rejected the saved authorization token as expired or revoked. Double-click **Reconnect Gmail.cmd** (or run `npm run auth`), open the printed Google authorization URL, and sign in to the Gmail account used by the extractor. After the success message, run the extractor again. Reconnecting replaces only the saved authorization token; invoice results and the email checkpoint are kept. You do not need to delete `token.json` or reset the Gmail start time.

If this keeps happening, check the OAuth app's publishing status in Google Cloud Console. External apps in **Testing** that request Gmail access receive refresh tokens that expire after seven days. Configure an appropriate production app for ongoing use, following [Google's OAuth requirements](https://developers.google.com/identity/protocols/oauth2#expiration). Tokens can also be revoked for other reasons; the error alone does not identify which reason applies.

## Choose previous or new results

Double-click `Run Invoice Extractor.cmd` and choose:

1. **Keep previous results and add new invoices** (default): CSV/JSON results continue to accumulate.
2. **New results only**: back up and clear previous active invoice results, then process the next email batch.
3. **Cancel**: exit without starting a batch.

Fresh mode first saves a complete SQLite backup and moves the old JSON/CSV exports into `data/backups/fresh-results-<timestamp>-<id>/`. It clears active invoice headers, line items, extraction history, duplicate results and invoice-number claims, then creates empty active CSVs. It retains all original downloaded PDFs in `data/pdfs/`, successful attachment tracking and the last-run checkpoint. Therefore it still reads emails since the last successful run and does not reload old processed attachments. Invoice-number checks start again within the fresh result set. If no new emails exist, the new CSVs contain only their headers.

If the database reset fails, its transaction rolls back and archived exports are moved back. If email reading fails after a successful reset, the previous results remain available in the backup and the checkpoint is unchanged for a retry. Close CSVs open in Excel before selecting fresh mode, as Windows may prevent moving a locked export.

`npm start` also presents the menu in an interactive terminal. For scripts, choose explicitly:

```powershell
npm start -- --keep
npm start -- --fresh
```

Without a terminal, `npm start` defaults to keeping previous results. `--choose` explicitly requests the menu. Fresh mode runs only when selected; installing this update does not clear current results.

## Save or print original invoices

After a successful batch with new unique invoices, the launcher offers **Finish**, **Save originals**, **Print originals**, or **Save and print**. These actions cover only invoices added in that run, including records recovered when retrying an interrupted batch. Earlier saved invoices, duplicate-number attachments, bin tags and other non-invoice documents are excluded. Printing is never automatic; Enter finishes without printing.

Invoice PDFs are saved under `data/original-invoices/<run-id>/`, with one file per invoice number and a `manifest.json`. For unsigned files, the app copies original recipient pages, preserving their page content, rather than rebuilding an invoice from CSV values. For signed files, it preserves the **complete attachment byte for byte**, including any other copy pages, because extracting pages would discard the signature. Only the first recipient page is selected for printing. Original pages may include continuation pages. Unmarked single-page invoices can be included when their invoice number matches; ambiguous multi-page PDFs or conflicting invoice numbers are skipped with a reason. Complete, unchanged attachments also remain in `data/pdfs/`.

To save or print the **last completed batch** later without reading Gmail again, double-click `Original Invoices.cmd`, or run:

```powershell
npm run originals -- --save
npm run originals -- --print
```

The last-batch selection is replaced on each successful email run, including a run with no new invoices. Save/print failures do not rewind the email checkpoint. A source SHA-256 check prevents exporting changed downloads.

For direct printing, install [SumatraPDF](https://www.sumatrapdfreader.org/free-pdf-reader) on each Windows PC and set its attached physical printer as the **Windows default printer**. The app detects standard SumatraPDF install locations; for a portable/custom installation, set its path in that PC's `.env`:

```ini
SUMATRA_PDF=C:\Program Files\SumatraPDF\SumatraPDF.exe
```

Printing uses [SumatraPDF's documented default-printer command](https://www.sumatrapdfreader.org/docs/Command-line-arguments), printing **only the first original-recipient page, one copy per unique invoice**, from a byte-identical copy of the downloaded attachment. This is page 1 for the observed samples. No printer name or app-specific printer configuration is required; the printer selected as Windows default on that PC is used. SumatraPDF must be installed once per PC and is detected automatically in standard locations. A persistent `print_jobs` table prevents submitting the same invoice number again, even after selecting fresh results. Submission success means the printer command completed; it does not prove paper was physically produced. Interrupted or uncertain submissions are not automatically retried: check the Windows print queue before printing those files manually. Tests mock printer submissions; they do not send physical print jobs.

## SumatraPDF printing without signature checks

Printing uses SumatraPDF directly, with one first original-recipient page and one copy on the Windows default printer. No Adobe dialog, Python verifier, certificate chain or revocation check is involved. Existing `PRINT_ENGINE=adobe` and signature-related `.env` settings are ignored by printing; no settings migration is needed. Download SHA-256 checks and duplicate/uncertain-print protection remain enabled. Standalone signature diagnostic tools and older reports may remain on existing installations, but normal extraction, test runs and printing do not invoke them.

## Filtering

PDFs in ZIP attachments use the same invoice parsers, e-way bill extraction, CSV grouping, invoice-number duplicate checks and original-PDF printing as direct PDF attachments. Folders inside a ZIP are supported. Extracted PDFs retain their exact bytes and are saved in `data/pdfs/`; JSON includes `archiveName` and `archiveEntry` for traceability. Same-named files use the normal collision handling. Other files and nested ZIPs inside an archive are ignored.

ZIP processing is limited to 50 MB per archive, 25 MB per PDF, 200 MB of extracted PDFs, 1,000 archive entries and 200 PDFs per archive. Password-protected PDFs inside ZIPs, corrupt archives, checksum failures and exceeded limits appear in `failure-report.csv` and prevent the Gmail checkpoint from advancing. Successful entries are tracked separately, so a retry skips them. Password-protected archives need to be unpacked before emailing the PDFs directly.

Some invoice exporters append zero padding after a complete ZIP end record. The reader accepts that padding only when the end record and central-directory boundaries agree; extracted PDF size and checksum checks still apply. Other unexpected trailing data and truncated archives remain errors.

Normal runs, latest-email tests and sample checks search for both PDF and ZIP attachments. Existing `.env` filters containing `filename:pdf` automatically include ZIP files, and the existing checkpoint is retained. To read ZIP emails older than that checkpoint, use **Reset Gmail Start Time.cmd** and select the required start time. Run `npm install` after updating to install the ZIP reader dependency.
Edit `config.json` to list the exact sender email addresses you want to process:

```json
{
  "allowedSenders": ["billing@example.com", "invoices@example.com"],
  "firstRunAfter": null,
  "invoiceNumberFilenameSenders": []
}
```

Addresses are matched without regard to letter case. Gmail search filters reduce fetched messages, and the actual `From` mailbox is checked again before downloading PDFs. Display names and wildcard/domain patterns are not treated as configured addresses. An empty list stops the run. `config.json` is ignored by Git to keep real sender addresses local.

When no checkpoint exists for the configured senders/query, the first run reads the **last 24 hours** of matching inbox emails, measured back from its startup time. This initial boundary is saved before reading Gmail, so failed runs retry the same window even if retried several days later. Existing checkpoints continue from the last successful run and are not reset to 24 hours. To choose an initial starting point explicitly, set `firstRunAfter` to an ISO timestamp with a timezone, such as `2026-11-01T00:00:00+05:30`, before the first run for that sender configuration.

After each successful batch, SQLite saves the completed time window. The next double-click processes emails received since that window, with a one-second overlap protected by attachment and invoice-number duplicate checks. The run freezes its upper boundary at startup, so mail arriving during the run is picked up next time. Failed downloads, PDF extraction errors, API failures or export errors leave the checkpoint unchanged; double-click again to retry. `NEEDS_REVIEW` is a completed extraction requiring human review, so it does not block the checkpoint.

Sender configurations have separate checkpoints. Changing `firstRunAfter` does not rewind an existing checkpoint. To change the saved start time, close the extractor and double-click **Reset Gmail Start Time.cmd** (or run `npm run reset:time`). Enter a date as `DD-MM-YYYY` and a 24-hour time as `HH:MM`; both use India Standard Time (UTC+05:30). Defaults are today's date and `06:00`. Choose **2 - Replay all matching emails** (default) to parse previously processed attachments again, including those whose results were archived, or **1 - Reset time only** to retain the skip behavior. Enter `Q` to cancel. Future or invalid times are rejected. Only the checkpoint for the current senders/query is changed; its previous value is recorded in SQLite reset history. Saved results, PDFs, attachment deduplication and print history are retained. Then run the extractor with **Keep previous results**. Replay is limited to matching emails in the chosen time window; configured sender and Gmail-query filters still apply. Replay stays enabled through failures/retries and turns off after a successful run. Invoice-number deduplication and print history remain active. For local files already recorded in SQLite, `npm run reprocess` is also available.

Optional `.env` settings add further Gmail restrictions; sender and time-window filters always apply:

```ini
GMAIL_QUERY=in:inbox has:attachment {filename:pdf filename:zip}
PAGE_SIZE=50
```

Every result page is processed. `POLL_SECONDS` and `MAX_MESSAGES_PER_POLL` are no longer used. The date window uses epoch seconds to avoid Gmail's timezone interpretation of date-only search terms; see [Google's filtering guide](https://developers.google.com/workspace/gmail/api/guides/filtering).

## Output
- `data/pdfs/`: all new original downloads share this single folder. Original attachment filenames are preserved by default, including spaces and Unicode; unsafe Windows characters are sanitized. Add sender addresses to `invoiceNumberFilenameSenders` in `config.json` to save their new tax-invoice PDFs using the extracted invoice number (e.g. `DS0003468341.pdf`). Original names stay in metadata; unreadable invoice numbers fall back to the attachment name. Different PDFs with the same name receive ` (2)`, ` (3)`, etc. Byte-identical files with the same name reuse the existing file while retaining separate attachment provenance. Existing downloads remain at their saved paths. Saved originals likewise share one folder per run, with no per-invoice subfolders.
- `data/json/`: one JSON document per attachment
- `data/invoices.csv`: main export, excluding repeated invoice numbers
- `data/duplicates.csv`: historical and newly detected duplicates with links to their original invoice records
- `data/failure-report.csv`: failed attachments and invoices needing review, with filenames, statuses and reasons (header-only when no issues exist)
- `data/signature-report.csv`: digital-signature verification results and reasons for checked active invoices
- `data/original-invoices/`: selected original-recipient invoice PDFs, grouped by run
- `data/invoices.db`: SQLite database, tables `invoices` and `attachments`

The `attachments` table tracks download/extraction attempts. Failed attachments are retried on the next manual run; a retained local PDF is reused. `done` means the processing attempt completed; check `validation_status` before using any record for accounting. Never delete tracking rows to reprocess files. Use the local command below.

`failure-report.csv` is regenerated with the other exports. It distinguishes `FAILED` (download/extraction failed) from `NEEDS_REVIEW` (fields were extracted but validation needs attention), and includes download failures that occurred before an invoice record could be created. Historical duplicate invoice rows are omitted from this report; their provenance remains in `duplicates.csv`. Fresh mode archives this report along with old CSV/JSON results. Printer submission results are recorded separately in `print_jobs` and the original-PDF batch's `print-result.json`.

## Invoice-number duplicate checks

Tax invoices are compared by invoice number across all senders and emails, after trimming outside whitespace and converting letters to uppercase. Separators and leading zeros remain significant: `INV/001` and `INV-001`, or `001` and `1`, are different numbers. Missing/malformed numbers are left for review rather than grouped together. Bin tags and other non-invoice documents do not participate.

New attachments with an existing invoice number are downloaded and retained, but no extra invoice row or line items are inserted. Their Gmail metadata, full extraction result and original-invoice link are stored in `duplicate_attachments`, exported as JSON with `isDuplicate`/`duplicateOf`, and listed in `duplicates.csv`. The original invoice is not overwritten.

The migration preserves historical invoice rows and IDs, marks repeat numbers with `duplicate_of`, and excludes them from the main CSV. It chooses an existing validated record first, otherwise a review record, otherwise the earliest available record. Subsequent runs keep that canonical record stable. An `invoice_numbers` table enforces a single canonical record per normalized number transactionally. Duplicate-number matching is global, including if suppliers reuse the same number; review the separate duplicates export in those cases.

## Limitations and production notes
- FST, Motherson/HUB and MAHLE layouts have dedicated parsers checked against local PDFs. The supplied signed MAHLE single-item format also needs decoding of its embedded private-use font mapping; this conversion is gated on MAHLE's known document labels and was checked against rendered PDF pages. Unknown symbol fonts are left unchanged for review. MAHLE's observed two-digit years are interpreted as 20xx; unsupported/multiple-item layouts require review. Other layouts use a conservative generic fallback. Astemo samples currently use that fallback; their line-item tables and party roles need a dedicated parser.
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

The main CSV has eight columns: `invoice_number`, `invoice_date`, `part_number`, `quantity`, `taxable_amount`, `IRN No`, `email_subject`, and `E-Way Bill No`. The original email subject is repeated on each line item from that email. It contains one row per part number within each invoice, with repeated parts combined by summing quantities and taxable amounts, excluding duplicate invoices and non-invoice documents. Taxable amount is the line item's amount before taxes. Invoice date uses ISO `YYYY-MM-DD`. A header-only/legacy invoice with no extracted items has blank item columns rather than invented values. E-way bill numbers are extracted from labeled 12-digit references, including the separated MAHLE declaration number/date layout; missing or conflicting numbers stay blank, and conflicts require review. Reprocess downloaded PDFs to populate this new field in older results. Missing IRNs remain blank; IRNs are extracted from labeled 64-character hexadecimal references, including wrapped text. Conflicting IRNs require review. Existing records need local reprocessing to populate newly added IRNs. Formula-like CSV cells are escaped for spreadsheet safety. Full metadata, validation, line items and other extracted fields remain in JSON and SQLite; `duplicates.csv` retains its separate audit columns.

## SQLite migration and recovery

Migrations are additive, transactional and idempotent. Write transactions reserve the SQLite writer before reading to avoid stale-snapshot lock failures in WAL mode. Existing invoice IDs and `(gmail_id, attachment_key)` identities are preserved; upserts do not use `INSERT OR REPLACE`. Tables include `invoice_line_items`, `extraction_runs`, `schema_migrations`, `invoice_numbers`, `duplicate_attachments` and `app_state`; `invoices` receives additional nullable columns. Legacy rows remain unreviewed until reprocessed. Legacy monetary strings are kept until a new extraction supplies normalized values. The first manual launch creates a consistent SQLite backup before the invoice-number migration.

Each invoice extraction attempt records its candidate and saved result in `extraction_runs`; new duplicate attachment results have their own audit record. The first reprocessing also archives the legacy row. Empty new fields do not erase prior values: retained fields are listed explicitly in validation issues, and invoice results require review. Failed reprocessing preserves prior line items and invoice-number identity. New exports use distinct paths when historical duplicate rows shared a JSON filename. SQLite remains authoritative if an export is interrupted; exports are written through temporary files and recovered on the next run.

## Test latest configured emails

To parse the latest PDF email from each configured sender without using/updating the last-run time, double-click **Test Latest Emails.cmd** or run `npm run test:email`. Test PDFs, invoice CSV, attachment lists and failure reports go into a new `data/test-runs/` subfolder on each invocation. Normal results, the last batch and normal print history stay unchanged. After parsing, choose whether to print through SumatraPDF; use `npm run test:email -- --print` or **Test Latest Emails And Print.cmd** for direct printing, or `--no-print` for parsing only. Test printing uses SumatraPDF directly for one original page and one copy, and a separate persistent test print history prevents repeat/uncertain submissions. Downloaded test PDFs all share that run's `pdfs/` folder. Senders come only from `config.json`. See [SETUP.md](SETUP.md) for details.

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

CSV exports combine repeated part numbers within the same invoice into one row, summing quantities and taxable amounts with exact decimal arithmetic. Different invoices and different parts remain separate. Original PDF line items remain available in JSON and SQLite for validation and audit. This also applies to the test-email CSV; existing results use this format on the next export.

`npm test` uses Node's built-in test runner with isolated temporary databases. It covers classification, identifiers, GSTIN checks, vendor codes, line items/copy deduplication, malformed fields, exact arithmetic, migrations, metadata preservation, repeated reprocessing, tampered files, export recovery, quota retries, stable attachment tracking, invoice-number duplicate prevention, exact sender filtering, pagination, single-run checkpoints, failed-run recovery, overlapping launch prevention, fresh-results backup/rollback, original-recipient page selection, current-run export and printer submission deduplication. Real local FST, HUB, Astemo, bin-tag and colour-code PDFs are used when available; those cases explicitly skip when PDFs are absent. No credentials, Gmail calls or physical print jobs are needed.

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
