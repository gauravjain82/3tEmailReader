@echo off
setlocal
cd /d "%~dp0"
title Norma Invoice and Stock Parser
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and try again.
  pause
  exit /b 1
)
node src\norma\service.js
set "NORMA_RESULT=%ERRORLEVEL%"
echo.
if "%NORMA_RESULT%"=="0" (
  echo Norma processing completed. Check the workbook and Done folder.
) else (
  echo Review the error above. Files with errors stay in Pending.
)
pause
exit /b %NORMA_RESULT%
