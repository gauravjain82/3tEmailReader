# Set up 3tEmailReader on each Windows PC

Follow these steps once on each machine. VS Code is optional. Setup does not clear invoice data, change the default printer, or print a test page.

## 1. Get the latest project

Download the code from [3tEmailReader on GitHub](https://github.com/gauravjain82/3tEmailReader) using **Code > Download ZIP**, then extract it into a permanent local folder. If using Git, run `git pull` in your existing checkout.

Use a separate local installation on each PC. Do not copy `node_modules`, `.signature-venv`, `.handwriting-venv`, or another machine's `token.json`. Each PC has its own results, checkpoints and print history, so the same invoice can be processed independently on different PCs.

## 2. Install Node.js 22 or 24

Node 24.22.1 is supported; you do not need to downgrade. Download the Windows installer from the [official Node 24 folder](https://nodejs.org/download/release/latest-v24.x/) and choose the file ending in **-x64.msi** for an ordinary Intel/AMD Windows PC (ARM64 PCs need the ARM64 installer). Keep npm and PATH integration selected.

Close and reopen your terminal, then check:

```powershell
node --version
npm --version
```

Node should report `v22...` or `v24...`. This project pins `better-sqlite3` 12.11.1 to support both. Visual Studio Build Tools are normally unnecessary when the matching prebuilt SQLite binary can be downloaded.

## 3. Optional Python 3.12 for rejection handwriting only

The tested version is **Python 3.12.10 (64-bit)**. Download the **Windows installer (64-bit)** from [the official Python 3.12.10 release](https://www.python.org/downloads/release/python-31210/), select **Add python.exe to PATH**, and use its default installation location. Avoid the latest-version download button, which may install a different Python series.

If **Python Install Manager** is already installed, install the actual 3.12 runtime (the manager alone is not Python):

```powershell
py install 3.12
py -3.12 --version
```

Alternatively, in PowerShell or Command Prompt:

```powershell
winget install --id Python.Python.3.12 --exact --source winget
```

Close and reopen the terminal after installation. If using the standalone installer, check:

```powershell
python --version
```

Gmail extraction and SumatraPDF printing do not require Python. Only the optional local rejection handwriting model uses **64-bit Python 3.12** in `.handwriting-venv`. The setup helper finds 3.12 through standard installation paths or `py -3.12`, and backs up a mismatched handwriting environment before rebuilding it. Skip Python and decline handwriting setup if this PC only needs Gmail extraction/printing.

## 4. Install SumatraPDF and set the printer

Install the **64-bit Installer**, using the standard location, from the [official SumatraPDF download page](https://www.sumatrapdfreader.org/download-free-pdf-viewer). Alternatively:

```powershell
winget install --id SumatraPDF.SumatraPDF --exact --source winget
```

Connect the printer and install its manufacturer's driver if needed. In Windows Settings, search for **Printers & scanners**, select the attached physical printer, and choose **Set as default**. Turn off **Let Windows manage my default printer** if the button is missing. [Microsoft instructions](https://support.microsoft.com/en-au/windows/hardware/printer/set-a-default-printer-in-windows).

Select your physical printer, such as Canon E470 series, rather than Export to WPS PDF, Microsoft Print to PDF, or OneNote. No printer name is configured in this app. Each PC uses its own Windows default printer.

## 5. Run Setup.cmd

Close any active extractor, rejection-parser or setup window, then double-click **Setup.cmd** in the project folder. Choose **1 - Install/configure this machine**. It walks through seven steps:

1. Install the locked Node dependencies with `npm ci`.
2. Create missing local settings and ask for allowed sender addresses.
3. Locate optional 64-bit Python 3.12 for handwriting; no signature verifier is installed.
4. Create `rejections/input` and offer to install the local handwriting model (**Yes by default**). It uses the same selected Python patch version in its own environment.
5. Check the Gmail credentials and optionally connect your account.
6. Explain the default-printer setup.
7. Show readiness for Gmail, SumatraPDF printing and optional rejection handwriting.

The handwriting step downloads approximately **1.3 GB for the pinned Microsoft TrOCR model**, plus CPU-only PyTorch and other packages. Allow disk space and time for the first installation. Model files are cached under `rejections/models/trocr-base-handwritten`; setup can be rerun without deliberately downloading a fresh copy. Later handwriting inference runs offline and does not upload invoice images. No GPU, Azure account, API key, or per-page OCR fee is needed. Choose No if this PC needs Gmail only; handwriting is optional for that workflow.

Enter sender addresses separated by commas. They are the **From addresses to accept**, not necessarily the mailbox you log in to. Existing `.env` and `config.json` are preserved unless you explicitly enter replacement senders; the previous sender configuration is backed up before replacement.

The first run defaults to the last 24 hours. Leave `firstRunAfter` as `null` unless you deliberately need a different initial date.

For a read-only status check, choose option 2 in Setup.cmd, or run:

```powershell
node scripts/setup.js --check
```

To install/retry the optional handwriting packages/model, use **Setup Handwriting OCR.cmd**. Internet access is needed for this installation. Setup does not automatically install system-wide Node, Python, SumatraPDF or printer drivers.

For Gmail/printing, check Node dependencies, Gmail credentials/token, SumatraPDF and the physical Windows default printer. OCR/model checks are optional for Gmail/printing. No certificate/Adobe/signature status is required. These readiness checks do not read Gmail messages, download models or print.

## 6. Connect Gmail on this PC

If your administrator already configured Google Cloud, obtain the **Desktop OAuth client JSON** and save it as `credentials.json` next to `Setup.cmd`. Do not commit it to Git.

For a new Google Cloud project, follow the [official Gmail setup guidance](https://developers.google.com/workspace/gmail/api/quickstart/nodejs): enable Gmail API, configure the OAuth consent screen, allow the Gmail read-only scope `https://www.googleapis.com/auth/gmail.readonly`, and create a **Desktop app** OAuth client. If the app is in testing, add the mailbox account as a test user. Download the client JSON as `credentials.json`.

Choose to connect Gmail during setup, or run this from the project folder:

```powershell
npm run auth
```

Open the printed authorization URL in a browser on the same PC and sign in to the mailbox to read. Complete Google's consent flow. The app creates `token.json` locally. Setup checks whether credentials/token files are configured; it does not test Gmail access by reading messages.

## 7. SumatraPDF printing

Printing has been restored to SumatraPDF without digital signature verification or Adobe automation. Install SumatraPDF once and select your physical printer as Windows default. The app prints the first original-recipient page, one copy per unique invoice, from the downloaded original. It keeps source-file SHA-256 integrity checks and duplicate/uncertain submission protection. Printer-command success confirms submission, not physical paper output.

Old `PRINT_ENGINE=adobe`, `ADOBE_READER` and signature-related `.env` settings are ignored for printing. Existing invoice data, Gmail checkpoint, downloaded PDFs and print history are retained. No signature setup, certificate import, Reader setup or Python is needed for Gmail/printing. Standalone historical verification tools/reports are optional and are not called by this workflow.

## 8. Run invoices

For a test that ignores the saved last-run time, double-click **Test Latest Emails.cmd** or run `npm run test:email`. It selects the latest email containing PDFs from **each exact sender configured in `config.json`**, including archived mail (Gmail normally excludes Spam/Trash). It does not use `firstRunAfter`, the normal Gmail query or the extraction checkpoint. It compares received times across the search results, so mailboxes with a large history can take longer to search.

Every invocation creates a new folder under `data/test-runs/<timestamp>-<id>/`, containing `invoices.csv`, a single `pdfs/` folder for all downloaded PDFs, `failure-report.csv`, `attachments.csv` (downloaded attachment metadata, including duplicates), and `test-report.json`. No subfolder is created for each email or invoice. Original filenames are kept; different PDFs sharing a name use ` (2)`, ` (3)`, etc. Identical same-named PDFs share one file and keep their separate attachment audit records. New normal Gmail downloads also share `data/pdfs/`. Existing files are retained at their saved paths.

After parsing, **Test Latest Emails.cmd** offers to print the unique test invoices through SumatraPDF. For direct printing, double-click **Test Latest Emails And Print.cmd** or run `npm run test:email -- --print`. For parsing only, run `npm run test:email -- --no-print`. Printing uses SumatraPDF directly on the Windows default physical printer for the first original-recipient page, one copy and Fit. It does not invoke Adobe or verify signatures. The test reuses complete downloads for printing; internal print snapshots/job files are kept separately under `print-work/`.

Normal results, invoice deduplication history, normal print history, `last-run-invoices.json` and the last-run checkpoint are retained unchanged. Test print submissions are tracked separately under `data/test-runs/print-history/`; successful or uncertain test jobs are not automatically submitted again, even on the next test run. This test history does not consult or alter normal print history. Read `print-result.json` for print failures/blocked/uncertain jobs. There is no clear-old-data prompt. Tests do not mark those emails processed for the normal extractor. Gmail sign-in/token refresh still works normally.

Double-click **Run Invoice Extractor.cmd**:

1. Select **Keep previous results** (default) or **New results only**. Clearing old results happens only when you choose it, with a backup first; downloaded PDFs and the checkpoint are retained.
2. Wait for the batch to finish. The first run reads the last 24 hours; later runs continue from the saved checkpoint.
3. If new unique invoices exist, choose **Finish**, **Save originals**, **Print originals**, or **Save and print**. Printing uses one first original-recipient page per unique invoice without signature verification.

Open `data/invoices.csv` in Excel. It contains `invoice_number`, `invoice_date`, `part_number`, `quantity`, `taxable_amount`, `IRN No`, and `email_subject`. Other outputs:

- `data/pdfs/`: complete downloaded attachments.
- `data/original-invoices/`: invoice PDFs selected for saving/printing; signed files are retained intact.
- `data/duplicates.csv`: duplicate invoice records.
- `data/failure-report.csv`: extraction failures/review reasons.
- Historical `data/signature-report.csv`, if present, is not used for printing.
- `data/backups/`: backups made before clearing or applicable migrations.

**Original Invoices.cmd** offers saving/printing from the last completed batch without reading Gmail again. Close CSV files in Excel before running exports or clearing results.

## 9. Run local rejection PDFs and handwriting

1. During **Setup.cmd**, choose Yes for handwriting in step 4. If it was skipped, double-click **Setup Handwriting OCR.cmd** later.
2. Run `node scripts/setup.js --check`. For handwriting, check Python 3.12 (tested: **3.12.10**), rejection/OCR packages, handwriting packages and model files. Gmail credentials are not required for the local rejection workflow.
3. Put rejection PDFs in **rejections/input** and double-click **Parse Rejection Invoices.cmd**.
4. Open the latest folder under **rejections/output**, then **rejections.csv**. The 14-column format is retained. Item and supplier-city values come from the PDF; part/plant/customer codes use your mappings in **src/rejections/mappings.json**. Unknown part names remain empty.
5. Read **review-report.csv** and **discrepancy-report.csv** for unresolved readings. The local model reads only Ack No and Ack Date, and attempts to fill consistent valid candidates. Handwriting disagreements, invalid dates, and model-derived values remain traceable in the reports.

Use **Test Handwriting OCR.cmd** to test just the two handwritten fields on one PDF. It creates diagnostic crops/results under **rejections/handwriting-tests** without changing Gmail data or an existing invoice CSV. See [REJECTIONS.md](REJECTIONS.md) for mappings, all output files and OCR limitations.

## Troubleshooting

| Problem | Action |
| --- | --- |
| `node` or `python` not found | Reopen the terminal after installation; check PATH integration. If Python opens Microsoft Store instead, install Python from python.org and review Windows app execution aliases. |
| `npm ... find VS` on Node 24 | Confirm this is the updated project with `better-sqlite3` 12.11.1. Run `npm ci`. On an older checkout: `npm install better-sqlite3@12.11.1 --save-exact`. If it still fails, check the earlier download/network error: GitHub access is needed for the prebuilt binary. VS Code does not provide C++ build tools. |
| Existing setup/extraction is active | Wait for its window to finish, then rerun Setup.cmd. Do not delete a lock file for a process that is still running. |
| Google authorization fails | Check the Desktop client, enabled Gmail API and test-user configuration; run `npm run auth` again. Port 3000 must be available for the local OAuth callback. |
| SumatraPDF not detected | Use its standard installer, or set `SUMATRA_PDF` to the full executable path in `.env`. |
| Signature verifier not found | Run Setup Signature Verification.cmd. For a custom environment, set `SIGNATURE_PYTHON` to its Python executable in `.env`. |
| Python versions do not match | Run Setup.cmd option 1 with 64-bit Python 3.12 installed, and choose Yes for handwriting. Both environments are created from the same selected interpreter; mismatched versions are backed up first. Remove an obsolete `SIGNATURE_PYTHON` override if it points elsewhere. |
| Handwriting packages/model need action | Run Setup Handwriting OCR.cmd with internet access. A failed/partial model download can be retried. Read-only checks do not download it. Gmail extraction can still run without this optional model. |
| CSV locked / `EBUSY` / `EPERM` | Close Excel or the application holding the file and retry. |
| No emails/invoices found | Confirm the connected mailbox, allowed sender addresses and saved time window. Changing senders gives that sender configuration a separate checkpoint. |

Keep `credentials.json`, `token.json`, `.env`, `config.json`, additional local certificates, and `data/` private. The seven approved public CA files are deliberately bundled for client deployment. Install updates into the existing local project and rerun setup as needed; retain the local settings and data. Git and VS Code are optional for day-to-day operation.
