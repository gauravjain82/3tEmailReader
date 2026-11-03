@echo off
setlocal
cd /d "%~dp0"
title Original Invoices - Last Run
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and try again.
  pause
  exit /b 1
)
node src\services\invoiceOutputService.js --choose
set "RUN_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RUN_RESULT%
