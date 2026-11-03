# Set up 3tEmailReader on each Windows PC

Follow these steps once on each machine. VS Code is optional. Setup does not clear invoice data, change the default printer, or print a test page.

## 1. Get the latest project

Download the code from [3tEmailReader on GitHub](https://github.com/gauravjain82/3tEmailReader) using **Code > Download ZIP**, then extract it into a permanent local folder. If using Git, run `git pull` in your existing checkout.

Use a separate local installation on each PC. Do not copy `node_modules`, `.signature-venv`, or another machine's `token.json`. Each PC has its own results, checkpoints and print history, so the same invoice can be processed independently on different PCs.

## 2. Install Node.js 22 or 24

Node 24.22.1 is supported; you do not need to downgrade. Download the Windows installer from the [official Node 24 folder](https://nodejs.org/download/release/latest-v24.x/) and choose the file ending in **-x64.msi** for an ordinary Intel/AMD Windows PC (ARM64 PCs need the ARM64 installer). Keep npm and PATH integration selected.

Close and reopen your terminal, then check:

```powershell
node --version
npm --version
```

Node should report `v22...` or `v24...`. This project pins `better-sqlite3` 12.11.1 to support both. Visual Studio Build Tools are normally unnecessary when the matching prebuilt SQLite binary can be downloaded.

## 3. Install Python for signature verification

In PowerShell or Command Prompt:

```powershell
winget install --id Python.Python.3.12 --exact --source winget
```

Alternatively use the [official Python Windows installer](https://www.python.org/downloads/windows/) and select **Add Python to PATH**. Reopen the terminal and check:

```powershell
python --version
```

Python 3.12 is recommended; 3.10 or newer is required. Python is needed for signature verification before printing. CSV extraction itself uses Node.js.

## 4. Install SumatraPDF and set the printer

Install the **64-bit Installer**, using the standard location, from the [official SumatraPDF download page](https://www.sumatrapdfreader.org/download-free-pdf-viewer). Alternatively:

```powershell
winget install --id SumatraPDF.SumatraPDF --exact --source winget
```

Connect the printer and install its manufacturer's driver if needed. In Windows Settings, search for **Printers & scanners**, select the attached physical printer, and choose **Set as default**. Turn off **Let Windows manage my default printer** if the button is missing. [Microsoft instructions](https://support.microsoft.com/en-au/windows/hardware/printer/set-a-default-printer-in-windows).

Select your physical printer, such as Canon E470 series, rather than Export to WPS PDF, Microsoft Print to PDF, or OneNote. No printer name is configured in this app. Each PC uses its own Windows default printer.

## 5. Run Setup.cmd

Close any active extractor window, then double-click **Setup.cmd** in the project folder. Choose **1 — Install/configure this machine**. It walks through six steps:

1. Install the locked Node dependencies with `npm ci`.
2. Create missing local settings and ask for allowed sender addresses.
3. Create a local Python environment and install the signature verifier.
4. Check the Gmail credentials and optionally connect your account.
5. Explain the default-printer setup.
6. Show which prerequisites are ready and which need attention.

Enter sender addresses separated by commas. They are the **From addresses to accept**, not necessarily the mailbox you log in to. Existing `.env` and `config.json` are preserved unless you explicitly enter replacement senders; the previous sender configuration is backed up before replacement.

The first run defaults to the last 24 hours. Leave `firstRunAfter` as `null` unless you deliberately need a different initial date.

For a read-only status check, choose option 2 in Setup.cmd, or run:

```powershell
node scripts/setup.js --check
```

To install/retry only the Python verifier, double-click **Setup Signature Verification.cmd**. Internet access is needed to install packages. Setup does not automatically install Node, Python, SumatraPDF or printer drivers.

## 6. Connect Gmail on this PC

If your administrator already configured Google Cloud, obtain the **Desktop OAuth client JSON** and save it as `credentials.json` next to `Setup.cmd`. Do not commit it to Git.

For a new Google Cloud project, follow the [official Gmail setup guidance](https://developers.google.com/workspace/gmail/api/quickstart/nodejs): enable Gmail API, configure the OAuth consent screen, allow the Gmail read-only scope `https://www.googleapis.com/auth/gmail.readonly`, and create a **Desktop app** OAuth client. If the app is in testing, add the mailbox account as a test user. Download the client JSON as `credentials.json`.

Choose to connect Gmail during setup, or run this from the project folder:

```powershell
npm run auth
```

Open the printed authorization URL in a browser on the same PC and sign in to the mailbox to read. Complete Google's consent flow. The app creates `token.json` locally. Setup checks whether credentials/token files are configured; it does not test Gmail access by reading messages.

## 7. Understand signature checks

Windows trusted roots are read automatically. If an issuer is not trusted, ask IT for its independently verified **public CA/root certificate** and place it in `certificates/trusted-roots/`. Do not add an invoice's signing certificate merely to make its warning disappear. Setup does not import certificates into Windows.

Only signatures verified as `VALID` can be printed automatically. Invalid, unknown, unsigned, unsupported or unavailable checks are reported and blocked. The supplied MAHLE `/adbe.pkcs7.sha1` format is unsupported by the verifier and stays `UNKNOWN`; adding a trusted CA alone does not fix this format limitation. The visual question mark is not replaced with a green tick.

"Printing prerequisites ready" means the required software/default printer was detected. It does not confirm certificate validity or physical paper output.

## 8. Run invoices

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

## Troubleshooting

| Problem | Action |
| --- | --- |
| `node` or `python` not found | Reopen the terminal after installation; check PATH integration. If Python opens Microsoft Store instead, install Python from python.org and review Windows app execution aliases. |
| `npm ... find VS` on Node 24 | Confirm this is the updated project with `better-sqlite3` 12.11.1. Run `npm ci`. On an older checkout: `npm install better-sqlite3@12.11.1 --save-exact`. If it still fails, check the earlier download/network error: GitHub access is needed for the prebuilt binary. VS Code does not provide C++ build tools. |
| Existing setup/extraction is active | Wait for its window to finish, then rerun Setup.cmd. Do not delete a lock file for a process that is still running. |
| Google authorization fails | Check the Desktop client, enabled Gmail API and test-user configuration; run `npm run auth` again. Port 3000 must be available for the local OAuth callback. |
| SumatraPDF not detected | Use its standard installer, or set `SUMATRA_PDF` to the full executable path in `.env`. |
| Signature verifier not found | Run Setup Signature Verification.cmd. For a custom environment, set `SIGNATURE_PYTHON` to its Python executable in `.env`. |
| `SIGNATURE_UNKNOWN` or `SIGNATURE_UNSIGNED` | Read `signature-report.csv` and the verification details. IT may need to supply a trusted root or resolve revocation access; unsupported signature formats require manual review. |
| CSV locked / `EBUSY` / `EPERM` | Close Excel or the application holding the file and retry. |
| No emails/invoices found | Confirm the connected mailbox, allowed sender addresses and saved time window. Changing senders gives that sender configuration a separate checkpoint. |

Keep `credentials.json`, `token.json`, `.env`, `config.json`, certificates, and `data/` private. Install updates into the existing local project and rerun setup as needed; retain the local settings and data. Git and VS Code are optional for day-to-day operation.
