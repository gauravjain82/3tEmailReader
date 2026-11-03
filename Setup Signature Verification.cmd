@echo off
setlocal
cd /d "%~dp0"
title Set Up Invoice Signature Verification
echo This installs the free PDF signature verifier for this project.
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.x or 24.x first. See SETUP.md.
  pause
  exit /b 1
)
node scripts\setup.js --signatures
if errorlevel 1 goto failed
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
