@echo off
setlocal
cd /d "%~dp0"
title Set Up Adobe Reader Printing
node scripts\setup-adobe-printing.js
set "ADOBE_SETUP_RESULT=%ERRORLEVEL%"
pause
exit /b %ADOBE_SETUP_RESULT%
