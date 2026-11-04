@echo off
setlocal
cd /d "%~dp0"
title Test Latest Emails and Print Through Adobe
echo Parse the latest PDF email from EACH configured sender and print unique invoices.
echo Adobe Reader's dialog will select one original page and one copy on the default printer.
echo Close Reader windows first and leave the desktop unlocked during automation.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Run Setup.cmd first.
  pause
  exit /b 1
)
node scripts\test-latest-email.js --print
set "EMAIL_PRINT_RESULT=%ERRORLEVEL%"
pause
exit /b %EMAIL_PRINT_RESULT%
