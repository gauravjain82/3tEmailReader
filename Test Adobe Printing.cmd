@echo off
setlocal
cd /d "%~dp0"
title Test Adobe Reader Dialog - No Printing
echo This test verifies one signed PDF and prepares Reader's print settings.
echo It will not click Print or add an invoice print job.
node scripts\test-adobe-printing.js
set "ADOBE_TEST_RESULT=%ERRORLEVEL%"
pause
exit /b %ADOBE_TEST_RESULT%
