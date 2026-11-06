@echo off
setlocal
cd /d "%~dp0"
title Rejection Invoices - Gemini on Vertex AI
echo Reads PDFs from rejections\input using Google Cloud Vertex AI.
echo Selected invoice pages are uploaded to Google Cloud. API usage is billable.
node scripts\parse-rejections.js --engine gemini
set "GEMINI_RESULT=%ERRORLEVEL%"
if not "%GEMINI_RESULT%"=="0" echo Review the messages above and review-report.csv if results were created.
pause
exit /b %GEMINI_RESULT%
