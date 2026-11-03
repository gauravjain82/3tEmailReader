@echo off
setlocal
cd /d "%~dp0"
title Set Up 3tEmailReader
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.x or 24.x, then reopen this window.
  echo See SETUP.md in this folder for the complete machine setup guide.
  echo Download: https://nodejs.org/download/release/latest-v24.x/
  pause
  exit /b 1
)
node scripts\setup.js
set "SETUP_RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %SETUP_RESULT%
