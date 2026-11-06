@echo off
setlocal
cd /d "%~dp0"
title Reset Gmail Start Time
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Run Setup.cmd first.
  pause
  exit /b 1
)
node scripts\reset-last-run.js
set "RESET_TIME_RESULT=%ERRORLEVEL%"
pause
exit /b %RESET_TIME_RESULT%
