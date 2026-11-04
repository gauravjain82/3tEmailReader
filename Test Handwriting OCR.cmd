@echo off
setlocal
cd /d "%~dp0"
title Test Local Handwriting OCR
echo This experiment reads only the top Ack No line and the lower Ack Date line.
echo Results are kept separate from the invoice CSV. No document images are uploaded.
node scripts\test-handwriting.js --choose
set "HANDWRITING_TEST_RESULT=%ERRORLEVEL%"
pause
exit /b %HANDWRITING_TEST_RESULT%
