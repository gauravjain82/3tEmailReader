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

## 3. Install one 64-bit Python 3.12 for both features

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

Both the Gmail signature verifier and rejection handwriting model use **64-bit Python 3.12**, selected by the same helper. Setup passes the same interpreter to both installers and checks the full major/minor/patch version. Existing environments with a different version are backed up under `data/backups/` and recreated. A different `python` command on PATH does not need to be uninstalled: setup also finds 3.12 via `py -3.12` and standard installation paths.

The environments remain separate: `.signature-venv` for pyHanko/PyYAML and `.handwriting-venv` for CPU PyTorch/Transformers/Pillow. They use the same selected Python version without sharing package installations. Python 3.10, 3.15, or a 32-bit runtime is not selected by these installers. If a custom `SIGNATURE_PYTHON` is set in `.env`, remove it to use the managed environment or ensure it uses the same 64-bit 3.12 patch version.

Gmail CSV extraction itself uses Node.js; Python is required for signature verification before printing and for the optional local handwriting model.

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
3. Select the shared 64-bit Python 3.12 runtime and install the signature verifier.
4. Create `rejections/input` and offer to install the local handwriting model (**Yes by default**). It uses the same selected Python patch version in its own environment.
5. Check the Gmail credentials and optionally connect your account.
6. Explain the default-printer setup.
7. Show readiness for Gmail, printing, local rejection parsing, handwriting packages/model files, and Python-version alignment.

The handwriting step downloads approximately **1.3 GB for the pinned Microsoft TrOCR model**, plus CPU-only PyTorch and other packages. Allow disk space and time for the first installation. Model files are cached under `rejections/models/trocr-base-handwritten`; setup can be rerun without deliberately downloading a fresh copy. Later handwriting inference runs offline and does not upload invoice images. No GPU, Azure account, API key, or per-page OCR fee is needed. Choose No if this PC needs Gmail only; handwriting is optional for that workflow.

Enter sender addresses separated by commas. They are the **From addresses to accept**, not necessarily the mailbox you log in to. Existing `.env` and `config.json` are preserved unless you explicitly enter replacement senders; the previous sender configuration is backed up before replacement.

The first run defaults to the last 24 hours. Leave `firstRunAfter` as `null` unless you deliberately need a different initial date.

For a read-only status check, choose option 2 in Setup.cmd, or run:

```powershell
node scripts/setup.js --check
```

To install/retry only the Python verifier, double-click **Setup Signature Verification.cmd**. To install/retry only the local handwriting dependencies and model, use **Setup Handwriting OCR.cmd**. Both use the shared Python 3.12 selector and back up mismatched environments. Internet access is needed for package/model installation. Setup does not automatically install system-wide Node, Python, SumatraPDF or printer drivers.

In the final checks, confirm both Python versions are identical, the signature verifier is OK, and (for rejection handwriting) the OCR packages and model files are OK. The check is read-only and does not download models, perform inference, read Gmail messages, or print. A complete model cache is checked against the pinned model ID/revision and required file list.

## 6. Connect Gmail on this PC

If your administrator already configured Google Cloud, obtain the **Desktop OAuth client JSON** and save it as `credentials.json` next to `Setup.cmd`. Do not commit it to Git.

For a new Google Cloud project, follow the [official Gmail setup guidance](https://developers.google.com/workspace/gmail/api/quickstart/nodejs): enable Gmail API, configure the OAuth consent screen, allow the Gmail read-only scope `https://www.googleapis.com/auth/gmail.readonly`, and create a **Desktop app** OAuth client. If the app is in testing, add the mailbox account as a test user. Download the client JSON as `credentials.json`.

Choose to connect Gmail during setup, or run this from the project folder:

```powershell
npm run auth
```

Open the printed authorization URL in a browser on the same PC and sign in to the mailbox to read. Complete Google's consent flow. The app creates `token.json` locally. Setup checks whether credentials/token files are configured; it does not test Gmail access by reading messages.

## 7. Understand signature checks

### Adobe Reader printing with its validated signature appearance

The optional Adobe mode automates the **English free desktop Reader** Print dialog. It preserves the complete signed attachment, requires the application's complete signature checks and then opens Reader's Print dialog as soon as the verified invoice window is available, selects the current Windows default physical printer, sets the selected original-recipient page and one copy, then invokes Print. No paid Acrobat license is required. Other interface languages or inaccessible/unrecognized controls stop the job. There is no automatic fallback to Sumatra or an all-pages print command.

1. Install/open Reader once and finish its first-launch prompts. In **Preferences > Signatures > Verification > More**, enable verification when opening a document. Confirm the same original invoice validates and prints with the desired appearance manually in Reader. The app's bundled CA files configure its own verifier; Reader must also establish trust using its own settings.
2. Set your attached physical printer as Windows' default, then double-click **Setup Adobe Printing.cmd**. It detects Reader and sets `PRINT_ENGINE=adobe` in the local `.env`. A nonstandard installation can use `ADOBE_READER` with the full executable path. No printer name is configured in the app.
3. Close Reader windows, then double-click **Test Adobe Printing.cmd** and paste the full path of one signed invoice. The test independently verifies the signature, opens a byte-identical local copy, uses the successful application verification and prepares one page/one copy in the Print dialog. It cancels the dialog without clicking Print or adding print-job tracking. Reports are under `data/verification/adobe-dry-run-<id>/`.
4. After the dry run passes, run the extractor and choose **Print originals**. Keep the desktop unlocked and leave the mouse/keyboard alone while Reader is being controlled. Reader stays open after submission so closing it cannot interrupt spooling; close its windows before the next batch.
5. Read `print-result.json` for submission results. An error before the Print invocation is retryable. A timeout/crash after invocation is **uncertain** and is not retried automatically; check the Windows queue and paper before any manual retry. Already submitted invoice numbers remain protected against duplicate printing across engines.

This integration needs a dry run and a real printed-page check on each target Reader version; it has no physical-printer verification on the development PC, which has no Reader installation. The visible green tick is rendered by Reader, and the application does not draw one. Custom PDF page labels require manual page selection and are blocked in automation. Adobe's API documentation describes [Reader automation limits](https://opensource.adobe.com/dc-acrobat-sdk-docs/library/interapp/index.html); this mode uses the desktop dialog instead of the all-pages command-line print option.

Reader's validation banner is no longer awaited or required to be readable through accessibility APIs. The app still requires complete successful signature verification bound to the unchanged source PDF. Reports use `applicationVerified: true` and `validationSource: "application"`; `readerValidated: null` means Reader's own status was not observed, rather than claiming Reader validated it. The visible signature appearance remains Reader's rendering.

To return to the existing Sumatra path, set `PRINT_ENGINE=sumatra` in `.env`.

If Reader opens but does not print, watch the `[Adobe]` progress messages in the command window. The batch now stops after the first automation failure instead of opening the remaining invoices. Each attempt writes `*.adobe-*.json.result.json` beside the internal print job, showing the exact stopped stage. When available, the matching `.diagnostic.json` captures Reader window titles and application controls (not rendered PDF text). A stalled step is stopped after 45 seconds without progress. Newly opened Reader windows are closed on a pre-submission failure where ownership can be established. Previously open windows and jobs with a Print invocation marker are retained. Send the stopped-stage message and diagnostic file for Reader-version-specific troubleshooting; do not repeatedly start the print batch without checking its reported result.

Run `npm run setup:check` to repeat the read-only machine checks. They verify all seven bundled CA files against the approved SHA-256 manifest, CA status, current validity dates and issuing chains. They also check the configured trust folder, legacy adapter files and whether `SIGNATURE_ALLOW_LEGACY_SHA1=true` is enabled. Missing/changed/expired certificates show ACTION NEEDED. These offline checks do not establish an individual invoice's signature or revocation status; that happens automatically before printing with internet access.

If signature setup used an incompatible Python version (for example 3.15), install **Python 3.12 64-bit**, close the extractor, and double-click **Repair Signature Setup.cmd**. It finds Python 3.12 in standard installation locations or via the Python launcher/PATH, backs up the existing `.signature-venv` under `data/backups/`, and recreates the verifier using Python 3.12. Internet access is required. If Python 3.12 is missing, it provides the official download link without moving the old environment. Invoice data and Gmail settings are retained. A custom `SIGNATURE_PYTHON` override must point to the repaired interpreter (or be removed to use the default).

Windows trusted roots are read automatically. If an issuer is not trusted, ask IT for its independently verified **public CA/root certificate** and place it in `certificates/trusted-roots/`. Do not add an invoice's signing certificate merely to make its warning disappear. Setup does not import certificates into Windows.

The tested PantaSign/Verasys/SignX chains use **CCA India 2022** as root, with **PantaSign CA 2022 / PantaSign Sub CA for DSC 2022** or **Verasys CA 2022 / Verasys Sub CA 2022** as intermediates. The FST chain uses **SignX CA 2022 / SignX sub-CA for Class 3 Individual 2022** under the same root. Only the root goes in `trusted-roots`; the six intermediate files go in `certificates/intermediates`. The seven approved public CA files are now included in Git in those folders and are loaded automatically on client PCs using the default trust directory. See `certificates/approved-manifest.json` for sources and fingerprints. Other local certificates and `.env` remain excluded; legacy SHA-1 compatibility still needs the local setting below. Signature, integrity, revocation and complete-file checks remain required.

### Existing SHA-1 invoices that Acrobat verifies

The verifier blocks SHA-1 by default. To accept existing SHA-1 invoices under an explicitly relaxed algorithm policy, add this line to your local `.env`, then restart the extractor or **Original Invoices.cmd**:

```dotenv
SIGNATURE_ALLOW_LEGACY_SHA1=true
```

This changes the algorithm policy for this application's signature checks (including certificate chains); MD2/MD5 and the existing key-size limits remain blocked. It does not skip certificate trust, required revocation information, integrity, or complete-file coverage. Reports record `legacySha1Allowed` and a warning when the option is enabled. Remove the line or set it to `false` to restore the default. This does not claim to duplicate Acrobat's validation policy or change the signature appearance in SumatraPDF.

If the remaining error is **no path to a trusted root**, obtain the correct issuer chain:

1. In Acrobat open the original PDF, open the **Signatures** panel, and select **Signature Properties > Show Signer's Certificate**. Review the chain shown by Acrobat. See [Adobe's validation instructions](https://helpx.adobe.com/acrobat/desktop/e-sign-documents/manage-digital-signatures/validate-digital-sign.html).
2. Obtain the matching public root CA certificate from the issuer's official website or your IT administrator, and verify its SHA-256 fingerprint against an independent trusted source. For Indian CCA roots, the [official CCA root-certificate page](https://cca.gov.in/root_certificate.html) publishes them. Do not choose a root simply because its name looks similar.
3. Place the verified root certificate (`.cer`, `.crt`, `.pem`, or `.der`) in `certificates/trusted-roots/`. Place any missing intermediate CA certificates in `certificates/intermediates/` (create that folder if needed). Intermediates help build the chain and are not treated as trust anchors. With a custom `SIGNATURE_TRUST_DIR`, the `intermediates` folder is a sibling of the configured root folder.
4. Keep internet access available for the issuer's OCSP/CRL services. Retry **Original Invoices.cmd > Print originals** for the last batch; this verifies the original again before submitting it to the printer. A previous successful/uncertain print submission is still protected against repeat printing.
5. Read `data/signature-report.csv` for the result and `data/signature-details.json` for the full per-signature diagnostics and policy warning. If verification remains `UNKNOWN`, no print job is submitted for that invoice.

No sender signing key, password, `.pfx`, or `.p12` file is needed. A root certificate must represent a CA that your organisation trusts; a successful integrity check alone is not issuer authentication.

Only signatures verified as `VALID` can be printed automatically. Invalid, unknown, unsigned, unsupported or unavailable checks are reported and blocked. The supplied MAHLE `/adbe.pkcs7.sha1` format is supported by the application adapter when `SIGNATURE_ALLOW_LEGACY_SHA1=true` is set in the local `.env`. The adapter checks the PDF-to-encapsulated-digest binding, CMS signature, trusted chain, required revocation evidence, modification policy and complete final coverage. No additional installation is needed beyond the existing signature setup; include both `scripts/verify_pdf_signature.py` and `scripts/legacy_pdf_signature.py` when updating a PC. Unknown legacy seed-value constraints remain blocked for review. The visual question mark is not replaced with a green tick.

"Printing prerequisites ready" means the required software/default printer was detected. It does not confirm certificate validity or physical paper output.

## 8. Run invoices

For a test that ignores the saved last-run time, double-click **Test Latest Emails.cmd** or run `npm run test:email`. It selects the latest email containing PDFs from **each exact sender configured in `config.json`**, including archived mail (Gmail normally excludes Spam/Trash). It does not use `firstRunAfter`, the normal Gmail query or the extraction checkpoint. It compares received times across the search results, so mailboxes with a large history can take longer to search.

Every invocation creates a new folder under `data/test-runs/<timestamp>-<id>/`, containing `invoices.csv`, a single `pdfs/` folder for all downloaded PDFs, `failure-report.csv`, `attachment-signatures.csv` (every downloaded attachment, including duplicates), and `test-report.json`. No subfolder is created for each email or invoice. Original filenames are kept; different PDFs sharing a name use ` (2)`, ` (3)`, etc. Identical same-named PDFs share one file and keep their separate attachment audit records. New normal Gmail downloads also share `data/pdfs/`. Existing files are retained at their saved paths.

After parsing, **Test Latest Emails.cmd** offers to print the unique test invoices through Adobe Reader. For direct printing, double-click **Test Latest Emails And Print.cmd** or run `npm run test:email -- --print`. For parsing only, run `npm run test:email -- --no-print`. Printing automatically controls Reader's dialog, uses the application's completed signature verification without waiting for Reader's status message, selects the Windows default physical printer, and sets the first original-recipient page, one copy and Fit. Run **Test Adobe Printing.cmd** on the target PC first; the desktop must remain unlocked and Reader must be closed before the batch. The test reuses complete downloads for printing; internal print snapshots/job files are kept separately under `print-work/`.

Normal results, invoice deduplication history, normal print history, `last-run-invoices.json` and the last-run checkpoint are retained unchanged. Test print submissions are tracked separately under `data/test-runs/print-history/`; successful or uncertain test jobs are not automatically submitted again, even on the next test run. This test history does not consult or alter normal print history. Read `print-result.json` for print failures/blocked/uncertain jobs. There is no clear-old-data prompt. Tests do not mark those emails processed for the normal extractor. Gmail sign-in/token refresh still works normally.

Double-click **Run Invoice Extractor.cmd**:

1. Select **Keep previous results** (default) or **New results only**. Clearing old results happens only when you choose it, with a backup first; downloaded PDFs and the checkpoint are retained.
2. Wait for the batch to finish. The first run reads the last 24 hours; later runs continue from the saved checkpoint.
3. If new unique invoices exist, choose **Finish**, **Save originals**, **Print originals**, or **Save and print**. Printing uses one first original-recipient page per unique invoice after signature approval.

Open `data/invoices.csv` in Excel. It contains `invoice_number`, `invoice_date`, `part_number`, `quantity`, `taxable_amount`, `IRN No`, and `email_subject`. Other outputs:

- `data/pdfs/`: complete downloaded attachments.
- `data/original-invoices/`: invoice PDFs selected for saving/printing; signed files are retained intact.
- `data/duplicates.csv`: duplicate invoice records.
- `data/failure-report.csv`: failures/review reasons, including blocked signatures.
- `data/signature-report.csv`: signature check results.
- `data/backups/`: backups made before clearing or applicable migrations.

**Original Invoices.cmd** offers saving/printing from the last completed batch without reading Gmail again. Close CSV files in Excel before running exports or clearing results.

## 9. Run local rejection PDFs and handwriting

1. During **Setup.cmd**, choose Yes for handwriting in step 4. If it was skipped, double-click **Setup Handwriting OCR.cmd** later.
2. Run `node scripts/setup.js --check`. For a full installation, both Python versions should show the same value (tested: **3.12.10**), with OK for signature verification, rejection/OCR packages, handwriting packages, model files and version alignment. Gmail credentials are not required for the local rejection workflow.
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
| PyYAML build/config error | Updated setup upgrades pip, repairs PyYAML using its pinned 6.0.3 wheel, and requires prebuilt wheels for signature dependencies. Use standard 64-bit Python 3.12. Check the displayed **Verifier Python** version: an existing `.signature-venv` can still use an older/different interpreter after system Python changes. If pip says no matching distribution, capture the complete error and check Python architecture and package-index access; source compilation is not attempted. |
| `SIGNATURE_UNKNOWN` or `SIGNATURE_UNSIGNED` | Read `signature-report.csv` and the verification details. IT may need to supply a trusted root or resolve revocation access; unsupported signature formats require manual review. |
| CSV locked / `EBUSY` / `EPERM` | Close Excel or the application holding the file and retry. |
| No emails/invoices found | Confirm the connected mailbox, allowed sender addresses and saved time window. Changing senders gives that sender configuration a separate checkpoint. |

Keep `credentials.json`, `token.json`, `.env`, `config.json`, additional local certificates, and `data/` private. The seven approved public CA files are deliberately bundled for client deployment. Install updates into the existing local project and rerun setup as needed; retain the local settings and data. Git and VS Code are optional for day-to-day operation.
