# Local rejection invoices — PDF input only

This separate workflow reads local PDFs and applies your explicit part/plant mappings from **src/rejections/mappings.json**. It never reads Excel or acknowledgement overrides. Existing `rejections/config.json` files from the earlier implementation are ignored. It does not access Gmail credentials, email checkpoints, the main invoice database, signature verification or a printer. Python is needed only for the optional local handwriting model. The default workflow runs locally; the separate Gemini command below sends selected invoice pages to Google Cloud.

The current parser supports the supplied Maruti Suzuki **Tax Invoice (Against Rejection)** layouts for Gurgaon/MF02 (HG invoice numbers) and Manesar/MF03 (HE invoice numbers), several invoice pages per PDF and line items. Image-only pages automatically receive full-page and table OCR before parsing; embedded-text pages keep their existing parsing path. Other layouts and unreadable fields are reported for review. It compares every field using two separate local OCR engines: Windows.Media.Ocr and Tesseract.js, with embedded PDF text retained as a third reference where available. Handwriting recognition is not guaranteed.

## Run

1. Install the project's Node dependencies (`npm ci`) once. Node.js 22 or 24 is required.
2. Put PDFs in **rejections/input** (create the folder or run **Parse Rejection Invoices.cmd** once).
3. Double-click **Parse Rejection Invoices.cmd**.
4. Open **rejections/output**, the latest run folder, then **rejections.csv** in Excel. Each run preserves earlier exports and source PDFs. All PDFs still in the input folder are read each time.

The command displays a result for each PDF, including its page count, exported rows and failed pages. **file-summary.csv** records these counts so that a detected PDF with unreadable pages is distinguishable from an input file that was skipped. One failed page does not prevent processing the remaining pages or files. Scanned PDFs take longer because every page must first be read as an image; OCR audit readings are saved under **page-ocr**.

The CSV retains the 14 template column names and order. The workbook defines the desired layout only and is not an input to the script. Values come from the PDF:

| Column | PDF source |
| --- | --- |
| Invoice Number / Invoice Date | Printed invoice header |
| PART NAME | Look up the PDF's Item Name in your supplied part mapping. Leave blank if not listed; do not substitute the printed description. |
| Item Name | Printed part/material number |
| Qty | Printed item quantity |
| Ack. No / Ack Date | Handwritten acknowledgement area; embedded text or local OCR, when unambiguous |
| Location(Plant) | Supplier city Gurgaon → Gurgaon(MF02); Manesar → Manesar(MF03) |
| Cust. Code | Same supplier-city mapping: Gurgaon → MFCM0MF02; Manesar → MFCM0MF03 |
| Basic value / Packing charges / CGST Amt. / SGST Amt. / Total Value | Printed item table; total must reconcile |

There is one row per item. Amounts have two decimal places, dates use DD.MM.YYYY, and no MF02 title row is inserted above the header. The six distinct supplied item mappings are in `src/rejections/mappings.json`, including alphanumeric item numbers such as 12221M68PC0-300 and 12221M78431-300. Duplicate entries in the supplied list resolve to the same mapping. Unmapped parts keep PART NAME empty. Unknown or ambiguous supplier cities keep both plant/customer columns empty and are flagged. A recipient address does not determine the supplier plant.

Raw printed descriptions, supplier city/postcode and bill-to code (e.g. M795) remain in `details.json` under `sourceFields` for traceability. They are not used as substitutes for your mapped output codes. Edit the mappings JSON to add future mappings, then start a new run.

## Two-engine OCR comparison and review

The script renders each page and crops all 14 fields. Windows.Media.Ocr reads an enhanced copy, and Tesseract.js reads a separate copy after table-line removal. The different engines read the same PDF independently; values are never copied between the engines. Crops are saved under **ocr-crops**. The English Tesseract model is installed with `npm ci`; OCR makes no cloud requests and uploads no documents. Windows OCR language support must already be installed. No system settings or language packs are changed by this script. Windows OCR is unavailable on other operating systems, which is reported as an engine error rather than a match.

For scanned pages, uncertain printed fields are retried with enlarged grayscale and black-and-white images, contrast adjustment, removal of long table rules, and small-angle deskewing. Crops include the final digit and separate tax amounts from percentage lines. These are temporary OCR images; the original PDF is unchanged. No additional Python package or model is required for this preparation. Source crops and enhanced variants remain in `ocr-crops`; `details.json` records each engine's attempts, rotation and scale. Conflicting valid readings within an engine remain flagged rather than choosing the value that fits a mapping or a total. Enlargement cannot recreate detail missing from the scan, and handwriting can still need review.

**ocr-comparison.csv** contains every comparison: source filename/page/line, field name, embedded-PDF candidate, Windows reading, Tesseract reading/confidence, status and raw readings. **discrepancy-report.csv** contains all entries requiring attention:

For mapped columns, OCR comparison uses the underlying PDF field: PART NAME is derived from each engine's Item Name; plant/customer values are derived from each engine's supplier-city reading. `comparison_source` records that dependency. Mapped codes are not expected to appear literally on the PDF. NO_MAPPING means a readable source has no supplied mapping and its output stays blank.

- MATCH: the engines agree, Tesseract meets the confidence threshold, and any existing PDF-text value agrees. This indicates agreement, not a guarantee of correctness.
- DISAGREEMENT: the two engines produced different values.
- PDF_TEXT_CONFLICT: both engines agree with each other but differ from the embedded text.
- MISSING_READING / UNREADABLE: one or both engines could not read the field; two blanks never count as a match.
- LOW_CONFIDENCE: the engines agree but Tesseract's confidence is below 70 for printed fields or 80 for acknowledgements.
- ENGINE_ERROR: an engine, rendering, model or field location was unavailable. It is never silently replaced by another engine.

Formatting differences such as `5` versus `5.00`, thousands separators, or dates written with month names are normalized before comparison. Digits are not substituted merely to make readings agree. Existing PDF-text candidates remain in the 14-column CSV when comparisons fail, with NEEDS_REVIEW in the page report; they are not automatically labelled verified or overwritten by the more confident engine. Quantity/unit-price and financial-total checks still apply even when both OCR readings match.

For image-only pages, agreeing Windows/Tesseract field readings above the confidence threshold can fill or correct full-page OCR candidates. The original candidate remains in `ocr-comparison.csv`, and corrections are recorded in `details.json`. Invoice identities are retained rather than changed during field comparison. Printed totals must still reconcile after corrections. When a quantity's decimal separator is unreadable, its value remains blank for field OCR/review instead of interpreting `500` as either 5 or 500. Scanned rows remain flagged for review.

A 10-digit acknowledgement number and a valid date may be filled when both engines agree on both fields, Tesseract confidence is at least 80, and neither conflicts with an accepted PDF-text value. A lone reading is retained only as a candidate. Ambiguous or invalid values remain blank. A short acknowledgement year uses the century of the printed invoice year. The sample handwriting may still require manual review. Nothing is copied from Excel, guessed from invoice order, or substituted from the invoice date.

**review-report.csv** lists every page as PARSED, NEEDS_REVIEW, FAILED, DUPLICATE or DUPLICATE_CONFLICT. **details.json** contains provenance, all comparisons, OCR candidates, crop paths and validation notes. **summary.json** contains invoice and comparison counts. Any unresolved comparison flags the page for review. A nonzero command exit status means review is needed or parsing failed; readable rows are still saved.

Duplicate invoice numbers within a batch are included once. Conflicting duplicates are reported and the first version retained for review. There is no cross-run deduplication database. Move completed PDFs elsewhere to include only new files in a later batch.

Earlier sample exports that used reference Excel values are historical outputs; use the latest run folder for the PDF-only export.

## Optional local handwriting-model experiment

To install the handwriting model for only the top Ack No and lower Ack Date lines, install **Python 3.12 64-bit** and run **Setup.cmd**, choosing Yes for handwriting in step 4. Python is used only for the optional handwriting model (tested: 3.12.10); Gmail extraction and SumatraPDF printing do not require Python. Existing environments with different Python versions are backed up and rebuilt. To install/retry only the handwriting component, double-click **Setup Handwriting OCR.cmd**. This creates `.handwriting-venv`, installs CPU-only PyTorch/Transformers, and downloads Microsoft's `trocr-base-handwritten` model at the pinned revision. The model is approximately 1.3 GB, in addition to Python packages, and is stored under `rejections/models`.

After setup, double-click **Test Handwriting OCR.cmd** and enter the rejection PDF path, or run:

```powershell
npm run handwriting:test -- --input "C:\Invoices\Rejection.pdf"
```

The test crops the two lines separately from each supported page. It runs the model on the original crop and a contrast-adjusted variant, entirely offline (`local_files_only` and offline environment flags). No PDF or image is uploaded. Inspect crops, `handwriting-test.csv`, raw `model-readings.json` and `review.json` under `rejections/handwriting-tests/<run>/`.

Once this local model is installed, **Parse Rejection Invoices.cmd** automatically attempts it for the two handwritten fields and fills structurally valid, consistent candidates in the new rejection CSV. The runtime remains completely offline. Only these two handwritten lines are read; signatures and other handwritten notes are excluded by the crop location. The model separates the lines by image content, deskews the handwriting, removes the long underline, and restricts decoding to digits/date separators. It never substitutes one digit for another or forces a fixed-length answer.

CONSISTENT_CANDIDATE means the original and contrast variants produce the same valid normalized value. They use the same model and are **not independent verification**. Whitespace and date separators can be normalized; the original readings are retained. Acknowledgement dates before the invoice date are rejected. Sequence scores are not calibrated accuracy estimates. Model-derived CSV values remain marked for review rather than silently being labelled verified. `ocr-comparison.csv`/`discrepancy-report.csv` include the local model candidate alongside Windows/Tesseract readings. An accepted value that conflicts with the local model is retained and the conflict reported as LOCAL_MODEL_CONFLICT.

`Test Handwriting OCR.cmd` remains a separate diagnostic that writes no invoice CSV. Model failures do not stop extraction of the printed fields. To skip this optional model for a run, use `node scripts/parse-rejections.js --no-handwriting`. Neither command changes Gmail results or print history.

## Optional Gemini extraction through Vertex AI

**Parse Rejection Invoices.cmd** continues to use the local parser. **Parse Rejections With Gemini.cmd** reads all PDFs in `rejections/input` through Vertex AI instead. Google Cloud billing and compatible authentication are required; each processed page is sent to Google Cloud. Gemini mode does not use the local TrOCR model or dual Windows/Tesseract comparison, and requires no Python or additional npm packages.

Follow the configuration examples in [SETUP.md](SETUP.md#optional-gemini-on-vertex-ai-for-rejection-invoices), then run **Check Gemini Setup.cmd**. The check loads credentials without sending an invoice or claiming that model access is verified.

Start with a bounded test on three pages:

```powershell
node scripts/parse-rejections.js --engine gemini --input "rejections/input/Mf03.pdf" --pages 1,3,5
```

The selected page numbers refer to each source PDF. To process all input PDFs after reviewing the test, double-click **Parse Rejections With Gemini.cmd** or run:

```powershell
node scripts/parse-rejections.js --engine gemini
```

The parser sends a one-page copy of the original PDF directly to Gemini with a structured schema. No Excel data, prior OCR candidates or mapping examples are sent. Returned part numbers and supplier cities are mapped locally to PART NAME and plant/customer codes. It retains every item row, checks decimal/date formats and financial totals, rejects inconsistent quantities, deduplicates by invoice number, and writes the same 14-column CSV and file/review reports in a fresh output folder. Unreadable/uncertain model fields stay blank. `gemini-audit` contains the returned extraction/response, source SHA-256, page number, model and token usage; `details.json` links each row to that audit. No API keys, access tokens, private keys or base64 request bodies are stored there.

Gemini PDF requests explicitly use `MEDIA_RESOLUTION_HIGH` by default. This provides more visual detail for small printed fields, at increased media-token usage. An optional `REJECTION_GEMINI_MEDIA_RESOLUTION` setting can select `MEDIA_RESOLUTION_LOW`, `MEDIA_RESOLUTION_MEDIUM`, or `MEDIA_RESOLUTION_HIGH`.

The initial Gemini request also includes enlarged, contrast-adjusted crops of the printed invoice header and top handwritten acknowledgement from that same PDF page. They help expose small invoice-number and year digits without supplying a proposed value. Crops and their source regions are retained in `gemini-part-crops` and linked from the audit. This uses more image tokens in the existing request, not another header-only API call. If the image renderer is unavailable, the original PDF is still sent and that limitation is flagged for review.

When an item number is missing, marked uncertain, or absent from your mapping, the runtime automatically makes **one additional billable Gemini request for that page**. It renders enlarged, contrast-adjusted crops of the part-number column and the repeated **Material** section in the supported Maruti layout. Gemini reads the two occurrences separately without seeing the first candidate or your mappings. A replacement is accepted only when both complete readings agree exactly and are not marked uncertain. PART NAME is then recomputed locally. The correction is based on the printed source, not a nearest-code lookup or an invoice-specific override. A genuine unlisted code can be retained when both occurrences agree, while its PART NAME remains empty.

If the two readings disagree, either occurrence is unavailable, or the focused check fails, the unconfirmed Item Name and PART NAME stay blank for review. Original and enhanced crops are stored in `gemini-part-crops`; `.parts.json` audits and `details.json` record the initial code, both focused readings, decision and extra token usage. This check is limited to unmapped/uncertain codes in the supported page layout; an incorrectly read code that happens to match another valid mapping can still require review. Both readings use the same AI model and are not independent verification. No local Python handwriting setup is required for this check.

Gemini outputs remain NEEDS_REVIEW model candidates, including when all fields are populated. Structured JSON and arithmetic checks do not prove correct transcription; manually compare the initial test pages against the original PDF, especially handwritten acknowledgement digits and part numbers. No independent OCR agreement is claimed, and the usual local OCR comparison CSVs are empty in Gemini mode. Authentication/model/quota failures stop further API requests for the batch, but remaining pages still receive failure-report entries; there are no automatic paid retries or silent local fallbacks.

## Local command line

```powershell
npm run rejections
npm run rejections -- --input "C:\Invoices\Rejection.pdf"
npm run rejections -- --input "C:\Invoices\Rejections"
```

`--output` accepts an empty folder; nonempty folders are rejected to preserve earlier exports. The `rejections` working folder is ignored by Git.
