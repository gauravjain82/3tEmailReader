@echo off
setlocal
cd /d "%~dp0"
title Repair Invoice Signature Setup
echo This recreates the signature verifier using 64-bit Python 3.12.
echo The previous verifier environment is backed up. Invoice data is retained.
echo Close the invoice extractor before continuing. Internet access is required.
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.x or 24.x first. See SETUP.md.
  pause
  exit /b 1
)
node scripts\setup.js --repair-signatures
if errorlevel 1 goto failed
echo.
echo Repair completed. Run npm run setup:check to check this PC.
pause
exit /b 0
:failed
echo.
echo Repair failed. Review the error above. See SETUP.md.
pause
exit /b 1
