@echo off
setlocal
cd /d "%~dp0"
title Local Rejection Invoice Parser
echo Put rejection PDFs in rejections\input, then run this file.
echo Results are saved in a new folder under rejections\output.
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.x or 24.x first. See SETUP.md.
  pause
  exit /b 1
)
if not exist "rejections\input" mkdir "rejections\input"
node scripts\parse-rejections.js
set "REJECTION_RESULT=%ERRORLEVEL%"
if not "%REJECTION_RESULT%"=="0" echo Review the messages above and review-report.csv if results were created.
pause
exit /b %REJECTION_RESULT%
