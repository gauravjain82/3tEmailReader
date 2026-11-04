@echo off
setlocal
cd /d "%~dp0"
title Test Latest Configured Emails
echo Test the latest PDF email from EACH sender configured in config.json.
echo This ignores the last-run time and saves separate test results.
echo It does not update the normal results, checkpoint or last-run batch, and does not print.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Run Setup.cmd first.
  pause
  exit /b 1
)
node scripts\test-latest-email.js
set "EMAIL_TEST_RESULT=%ERRORLEVEL%"
pause
exit /b %EMAIL_TEST_RESULT%
