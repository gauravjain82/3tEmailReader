@echo off
setlocal
cd /d "%~dp0"
title Check Vertex AI Authentication
node scripts\parse-rejections.js --check-gemini
set "GEMINI_CHECK_RESULT=%ERRORLEVEL%"
pause
exit /b %GEMINI_CHECK_RESULT%
