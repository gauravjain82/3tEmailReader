@echo off
setlocal
cd /d "%~dp0"
title Set Up Local Handwriting OCR
echo This optional setup installs CPU-only handwriting recognition in a separate environment.
echo Python 3.12 64-bit and internet access are needed for this one-time installation.
echo The model download is approximately 1.3 GB, plus Python packages.
echo Invoice images are processed locally and are not uploaded.
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.x or 24.x first. See SETUP.md.
  pause
  exit /b 1
)
node scripts\setup-handwriting.js
set "HANDWRITING_SETUP_RESULT=%ERRORLEVEL%"
pause
exit /b %HANDWRITING_SETUP_RESULT%
