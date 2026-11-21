# Norma invoice and daily stock service

This service runs separately from Gmail extraction and rejection parsing. It reads only local Norma PDFs and the configured Excel workbook. It does not use Gmail credentials, the main invoice database, Gmail checkpoints or printers.

## Run

1. Run `npm install` after updating the application.
2. Copy `norma/config.example.json` to `norma/config.json` if needed. The launcher creates this configuration on its first run if absent.
3. Put your three-sheet stock workbook at `norma/Norma stock.xlsx`, or change `workbookPath` to its actual location.
4. Drop PDFs into `norma/Pending`. Close the stock workbook in Excel.
5. Double-click **Run Norma Parser.cmd**, or run `npm run norma`.

The service reads the top-level PDF files in Pending once and exits. A PDF goes to Done only after its invoice records and stock changes are saved, or after verifying that the same records already exist. Invalid, conflicting, unsupported or unsaved files remain in Pending, with their reasons in the dated JSON report under `norma/Reports`. Other PDFs in the batch can still succeed. The original PDF bytes, including signatures, remain unchanged.

Rerunning an already recorded invoice also refreshes stock for its invoice date and following days, without adding duplicate sales rows. If sales are already present but an older stock day needs refreshing and its PDFs are in Done, run `npm run norma -- --stock-from 2026-11-19` (replace the date as needed; add `--config PATH` for another configuration). This rebuilds both regions' dispatches and following openings from that date through today, including when Pending is empty. It updates the configured workbook with a backup and preserves manual receipts, transfers and Transit. Choose the first date that needs correction; earlier stock entries supply the opening baseline and remain unchanged. As with reprocessing an older invoice, openings from the selected date onward are carried forward and any manual opening resets in that range are replaced.

The run window prints the exact workbook path and each invoice's sheet and row numbers. Newly added invoice rows inherit date/number formatting even when empty formatted rows already exist. The saved workbook opens on the updated sales sheet with a new invoice selected. For Ahmedabad invoices, look in **Norma sales report Smg**. If the workbook you opened looks empty, compare its full path with **Norma workbook output** in the run window.

The installation prepared during development has a local copy of the supplied stock workbook at `norma/Norma stock.xlsx`. The original workbook in Downloads is unchanged. These local business files are ignored by Git and are not included when pulling the code onto another PC; supply that PC's workbook and config separately.

## Configurable paths

All paths in `norma/config.json` can be absolute Windows paths or relative to that configuration file. For example:

```json
{
  "pendingDirectory": "D:/Norma/Pending",
  "doneDirectory": "D:/Norma/Done",
  "workbookPath": "D:/Norma/norma stock sheet.xlsx",
  "backupDirectory": "D:/Norma/Backups",
  "reportDirectory": "D:/Norma/Reports",
  "openingBalances": { "gurgaon": {}, "gujarat": {} }
}
```

Pending and Done must be separate, non-nested folders. Keep the workbook outside both. To use another configuration:

```powershell
npm run norma -- --config "D:/Norma/config.json"
```

Each run updates stock through today's date in India Standard Time. For a controlled historical run, specify its through-date:

```powershell
npm run norma -- --config "D:/Norma/config.json" --date 2026-11-15
```

Invoices dated after that through-date remain in Pending. Run the service daily, including days without new PDFs, to create daily stock rows and refresh the current day's dispatch totals.

## Sales sheets

The workbook must contain these exact names and the supplied column headings:

| Sheet | Routing |
|---|---|
| Norma sales report Smg | Ahmedabad/Gujarat ship-to; Plant = SMG |
| Norma sales report Ggn. | Gurgaon, Manesar and Kharkhoda ship-to |
| STOCK DETAILS | Separate Gurgaon and Gujarat daily balances |

Routing uses customer codes checked against the **ship-to** destination; the seller's Gurgaon address does not determine the destination. Recognised sample customers map to MSILG, MSILG SPD, MSILM, MSILM OES, MSILK and SMG. Other customers need an unambiguous supported ship-to location. Unknown or conflicting locations stay in Pending.

The customer part number, quantity, basic rate, printed assessable value, taxes and grand total come from each PDF item. S.NO continues the existing sequence. BILL DATE is an Excel date. Srv No. is blank, as requested; Ahmedabad REMARKS is also blank because the samples do not supply a report-specific remark. The Gurgaon sheet receives CGST and SGST; the Ahmedabad sheet receives IGST.

Original buyer pages are used once per invoice. Transporter, supplier and extra copies do not multiply sales or stock. An identical invoice already in the workbook is verified and skipped. A conflicting date, destination, part, quantity, rate or amount leaves the PDF in Pending. Existing workbook money values can differ by up to two paise because older rows use unrounded Excel calculations; existing figures are preserved. New rows use the PDF's printed amounts. Unrelated workbook entries, styles, merges and existing sales formulas are retained. Excel rebuilds its calculation chain when the updated workbook opens.

## Continuous stock ledger (recommended)

The redesigned workbook uses a continuous `STOCK LEDGER` sheet. The parser detects it automatically. Each row is identified by **Date + Location + Part No.**, so sorting, inserting rows, changing column widths or Excel's displayed date format does not change which stock entry is updated. Keep the header names and column order intact. Dates can be ISO text, Indian day/month/year text, or Excel date cells; the service writes ISO dates.

| Column | Maintained by |
|---|---|
| Date, Location, Part No. | Service; also identifies a manual movement row |
| Opening, Dispatch, Closing | Service, numeric values rebuilt on every run |
| Received, Transfer out, Transit, Notes | Manual inputs, preserved by key |

Enter quantities as numbers, not formulas. Gurgaon closing is opening + received - transfer out - dispatch. Gujarat closing is opening + received - dispatch; enter transfers to Gujarat as manual Gujarat receipts when received. Transit stays manual and does not change closing. New parts start at zero unless a configured initial opening is supplied before their first run. The service records their initial opening once.

`STOCK OPENINGS` stores one dated, numeric initial opening for each location and part. These explicit starting balances replace historical cell-reference chains. The service recalculates **every ledger day from that part's opening through today**, even when Pending is empty or an invoice already exists. Edits to sales quantities or manual movements therefore carry forward automatically. `--stock-from` is not needed for migrated workbooks. Negative balances are reported and remain visible.

Before saving and again after packing the XLSX, the service checks dispatch against the sales sheets and opening/closing arithmetic. Duplicate keys, missing/invalid openings, malformed current sales or manual quantities, and conflicting invoice reruns prevent saving and leave PDFs in Pending. A newly added invoice dated before its verified starting balance is refused: migrate from an earlier date to include it. Historical sales before the cutover are already represented by the starting balance and are not dispatched again.

### One-time migration

Close Excel and stop the parser. Select the first day to rebuild; the latest saved closing **before** that day supplies its initial opening. Review those balances against your records. The migration refuses an invalid saved initial balance rather than guessing it. Choose a new output filename:

```powershell
npm run norma:migrate -- --input "C:\Norma\Norma.xlsx" --output "C:\Norma\Norma-compatible.xlsx" --from 2026-11-19
```

Optional `--date YYYY-MM-DD` sets the last day to calculate; otherwise it is today in India. The source file is never overwritten. The output preserves both sales sheets and the old `STOCK DETAILS` sheet as history, imports manual movements from the cutover onward, adds `STOCK OPENINGS` and `STOCK LEDGER`, verifies the saved package and writes a `.migration.json` audit beside it. Future dated manual movements are preserved for later runs. Daily openings from the cutover onward are rebuilt; old manual opening resets are not carried over as independent adjustments.

If an old sales date is malformed, it can be preserved outside the new ledger only when valid surrounding sales dates establish that it predates the cutover. Such rows are listed in `STOCK LEGACY SALES` and the migration audit with fingerprints; no replacement dates are guessed. Edits/removal of those rows require review instead of silently excluding changed data. Invalid dates that cannot be established as pre-cutover history stop migration.

Set `workbookPath` in `norma/config.json` to the new compatible workbook and keep using **Run Norma Parser.cmd**. Paths for Pending, Done, Backups and Reports are unchanged. Future runs update this same configured workbook, not another generated workbook. Check `STOCK LEDGER` for current stock; the original `STOCK DETAILS` is retained for historical reference and is no longer used in calculations. You can filter the ledger by date and location. The report records `format: ledger-v1`, changed balances and `reconciliation.verified` with the row and dispatch totals.

## Daily stock in legacy workbooks

The following behavior applies only to workbooks that have not been migrated. For automatic reconciliation on idle runs, use the continuous ledger above.

Dispatches are **replaced with the total for that date and part from the corresponding sales sheet**, rather than incremented on each run. Repeating a run therefore does not subtract the same invoice again.

| Region | Closing balance |
|---|---|
| Gurgaon | Opening + received quantity − Gurgaon-to-SMG transfer − Gurgaon/Manesar/Kharkhoda customer dispatch |
| Gujarat | Opening + received quantity − Ahmedabad customer dispatch |

Opening stock is looked up from the worksheet's latest saved entry for the same region and part, dated before the day being processed. Entries are matched by their date and customer part number, rather than by a hardcoded row or by following historical opening formulas. If multiple entries share a date, the last matching entry in the worksheet wins. Entries dated after the processing day are excluded. The saved closing quantity is written as a numeric opening, so deleting or moving old rows cannot break a new opening through a cell-reference formula. Each lookup is recorded under `stock.openingSources` in the report, with the part, source date, source row and quantity. Cell addresses in that audit identify what was read; they are not persisted as opening formulas.

The latest closing normally supplies its saved numeric value without traversing old opening formulas. If that closing has a `#REF!` error caused by a standalone broken opening reference, the service can rebuild it automatically: start with the previous valid closing and apply each intervening day's receipts, transfers and dispatches. Dispatches come from matching sales rows when available, otherwise the recorded stock dispatch. Recorded manual receipts and transfers are preserved. Recovery requires the standard closing formula and understandable movements; unknown adjustments or other invalid closings still leave the PDF in Pending for correction.

When there is no earlier closing, recovery uses a recorded initial opening or the configured opening. A genuinely new part can use the zero-opening rule below; an unverified part with earlier sales cannot silently start at zero. Recovery saves numeric openings and recalculated closings in the configured workbook, with a backup before saving. The report's `stock.recoveries` records the basis, daily movements and changed cells, and the service logs recovered parts. No manual workbook repair is required for this supported broken-reference case. Recalculate and save the workbook after other manual formula or stock changes: historical formulas outside recovery use their saved results. New or changed daily closings calculated during this run are immediately available to the following day.

Newly encountered stock parts start at zero, as requested. You can set a nonzero initial opening in `openingBalances.gurgaon` or `openingBalances.gujarat` before that part first appears. Receipts, transfers and the Gujarat Transit column remain manual; a transfer does not automatically become a Gujarat receipt. Current-day closing formulas still calculate opening + receipts - transfers - dispatch. Negative balances are recorded in the report for review and are not silently adjusted.

Stock tables have complete cell borders, including blank receipts, transfer and Transit cells. Existing manual values and formulas are preserved when applying those borders. Normal runs update `workbookPath` in place; dated files in Backups are recovery copies, not a different active workbook.

New daily blocks cover every calendar day through the processing date. Adding an older invoice recalculates its dispatch day and following days; openings then use the latest earlier closing entries, including values recalculated in the current run. Manual receipts and transfers remain intact. Historic opening resets can consequently change when an older day is reprocessed. Historical blocks outside the affected date range are preserved. New parts are inserted into available blank rows of an existing block; if it has no free row, add a blank row in Excel and retry. For repeated date headings, the last worksheet entry is used; older copies are preserved. A run refuses to generate more than 370 days of missing stock blocks at once.

## Backups and interrupted runs

The service locks its workbook against simultaneous Norma runs, writes and validates a complete temporary workbook, backs up the previous workbook, then replaces it in place. The original remains intact if parsing, validation or saving fails. Close Excel before starting; an Excel owner lock or a concurrent workbook change prevents replacement.

After a successful workbook save, the PDF is copied unchanged to Done and removed from Pending. If the move fails or the process stops between saving and moving, retry: the workbook itself is checked for existing invoices, so sales and dispatches are not duplicated. Different PDFs with the same filename receive numbered names in Done. Never delete a `.norma.lock` file while its run is still active; after a crashed run, verify that no Norma process is running before removing the stale lock.

## Supplied sample verification

All six provided PDFs parse with matching item quantities, prices, taxes and totals. Each PDF contains repeated copies of a single invoice. All six invoice numbers already exist in the supplied workbook, so processing them against that workbook verifies the entries and adds no duplicate sales rows.

| Sample | Invoice | Plant | Customer part | Quantity |
|---|---|---|---|---:|
| GGN.pdf | 2620008781 | MSILG | 13892M74L60 | 250 |
| GGN SPD.pdf | 2620008716 | MSILG SPD | 18526M86J20 | 400 |
| MNSR V.pdf | 2620008793 | MSILM | 13892M74L60 | 250 |
| MNSR OES.pdf | 2620008117 | MSILM OES | 13893M74L60 | 500 |
| MSILK.pdf | 2620008806 | MSILK | 13894M74L60 | 500 |
| SMG.pdf | 2620008775 | SMG | 13892M74L60 | 1500 |

The parser currently supports the supplied text-based Norma layout. Scanned/image-only invoices, changed table order, ambiguous multi-page item continuations and mismatched financial totals stay in Pending for review. No paid OCR or cloud service is used.
