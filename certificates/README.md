This folder bundles seven approved public CA certificates for client PCs. Sources, SHA-256 fingerprints and validity dates are recorded in approved-manifest.json.

CCAIndia2022.cer is an application trust anchor. The six intermediate certificates help build the PantaSign, Verasys and SignX chains; they are not additional trust anchors. The default verifier loads these folders automatically. A custom SIGNATURE_TRUST_DIR uses that configured directory instead.

The bundle supports invoices chaining to these CAs. Other vendor chains may need separately reviewed CA certificates. Integrity, certificate validity, revocation evidence and complete-file coverage remain required. Internet access is needed for issuer revocation services. Legacy SHA-1 acceptance remains an explicit local .env setting described in SETUP.md.

No Windows certificate store changes are made. Private keys, vendor signing certificates, Adobe bulk exports and import-review files are not included in Git. Only the seven named CA files are allowed by .gitignore.
