@echo off
setlocal
cd /d "%~dp0"
title Reconnect Gmail
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and try again.
  pause
  exit /b 1
)
echo Open the Google authorization URL below in your browser and sign in.
echo Your saved invoices and email checkpoint are kept.
echo.
node src\auth.js
set "AUTH_RESULT=%ERRORLEVEL%"
echo.
if "%AUTH_RESULT%"=="0" (
  echo Gmail reconnected. Run Invoice Extractor.cmd again.
) else (
  echo Gmail reconnection failed. Review the error above and try again.
)
pause
exit /b %AUTH_RESULT%
