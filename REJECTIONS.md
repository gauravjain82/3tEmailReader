# Local rejection invoices — PDF input only

This separate workflow reads local PDFs and applies your explicit part/plant mappings from **src/rejections/mappings.json**. It never reads Excel or acknowledgement overrides. Existing `rejections/config.json` files from the earlier implementation are ignored. It does not access Gmail credentials, email checkpoints, the main invoice database, signature verification or a printer. Python is needed only for the optional local handwriting model.

The current parser supports the supplied Maruti Suzuki **Tax Invoice (Against Rejection)** layout with embedded text/OCR, several invoice pages per PDF and line items. Other layouts and scans without readable table text are reported for review. It compares every field using two separate local OCR engines: Windows.Media.Ocr and Tesseract.js, with the PDF's embedded text retained as a third reference. Handwriting recognition is not guaranteed.

## Run

1. Install the project's Node dependencies (`npm ci`) once. Node.js 22 or 24 is required.
2. Put PDFs in **rejections/input** (create the folder or run **Parse Rejection Invoices.cmd** once).
3. Double-click **Parse Rejection Invoices.cmd**.
4. Open **rejections/output**, the latest run folder, then **rejections.csv** in Excel. Each run preserves earlier exports and source PDFs. All PDFs still in the input folder are read each time.

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

**ocr-comparison.csv** contains every comparison: source filename/page/line, field name, embedded-PDF candidate, Windows reading, Tesseract reading/confidence, status and raw readings. **discrepancy-report.csv** contains all entries requiring attention:

For mapped columns, OCR comparison uses the underlying PDF field: PART NAME is derived from each engine's Item Name; plant/customer values are derived from each engine's supplier-city reading. `comparison_source` records that dependency. Mapped codes are not expected to appear literally on the PDF. NO_MAPPING means a readable source has no supplied mapping and its output stays blank.

- MATCH: the engines agree, Tesseract meets the confidence threshold, and any existing PDF-text value agrees. This indicates agreement, not a guarantee of correctness.
- DISAGREEMENT: the two engines produced different values.
- PDF_TEXT_CONFLICT: both engines agree with each other but differ from the embedded text.
- MISSING_READING / UNREADABLE: one or both engines could not read the field; two blanks never count as a match.
- LOW_CONFIDENCE: the engines agree but Tesseract's confidence is below 70 for printed fields or 80 for acknowledgements.
- ENGINE_ERROR: an engine, rendering, model or field location was unavailable. It is never silently replaced by another engine.

Formatting differences such as `5` versus `5.00`, thousands separators, or dates written with month names are normalized before comparison. Digits are not substituted merely to make readings agree. Existing PDF-text candidates remain in the 14-column CSV when comparisons fail, with NEEDS_REVIEW in the page report; they are not automatically labelled verified or overwritten by the more confident engine. Quantity/unit-price and financial-total checks still apply even when both OCR readings match.

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

## Optional command line

```powershell
npm run rejections
npm run rejections -- --input "C:\Invoices\Rejection.pdf"
npm run rejections -- --input "C:\Invoices\Rejections"
```

`--output` accepts an empty folder; nonempty folders are rejected to preserve earlier exports. The `rejections` working folder is ignored by Git.
