@echo off
setlocal
cd /d "%~dp0"
title Set Up Invoice Signature Verification
echo This installs the free PDF signature verifier for this project.
where python >nul 2>nul
if errorlevel 1 (
  echo Install Python 3.10 or newer from python.org and enable Add Python to PATH.
  pause
  exit /b 1
)
if not exist ".signature-venv\Scripts\python.exe" python -m venv .signature-venv
if errorlevel 1 goto failed
".signature-venv\Scripts\python.exe" -m pip install -r requirements-signatures.txt
if errorlevel 1 goto failed
if not exist "certificates\trusted-roots" mkdir "certificates\trusted-roots"
echo.
echo Verification is installed. Windows trusted roots are read automatically.
echo If an invoice issuer is not trusted, obtain its CA certificate from your IT team.
echo The app will report unknown signatures and will not automatically trust invoice certificates.
pause
exit /b 0
:failed
echo Signature verifier setup failed. Review the error above and try again.
pause
exit /b 1
