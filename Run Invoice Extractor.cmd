@echo off
setlocal
cd /d "%~dp0"
title Gmail Invoice Extractor
echo Processing new invoices from configured senders...
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and try again.
  pause
  exit /b 1
)
node src\index.js
set "RUN_RESULT=%ERRORLEVEL%"
echo.
if "%RUN_RESULT%"=="0" (
  echo Run complete. You can close this window.
) else (
  echo The run did not complete. Review the error above, then double-click again to retry.
)
pause
exit /b %RUN_RESULT%
