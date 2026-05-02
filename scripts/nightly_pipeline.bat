@echo off
REM ============================================================================
REM  nightly_pipeline.bat — Windows wrapper for the nightly billing pipeline.
REM
REM  Phase 1  email_automation     pulls Excels from Zoho, loads PO/GRN/ASN/
REM                                DC/Schedule/Invoice into RDS.
REM  Phase 2  ocr_automation       pulls PDFs from Drive, extracts via Landing
REM                                AI, writes ocr_snapshot, server-side
REM                                reconcile fires per invoice.
REM  Phase 3  ocr_automation.po_check
REM                                flags POs with GRN but no invoice raised.
REM
REM  Phase 2 runs only if email exited 0 (success) or 30 (partial success).
REM  Phase 3 runs unless OCR failed fatally (40 = all files failed, 99 = crash).
REM
REM  Logs are written to:
REM      C:\Users\Administrator\Documents\billing_system\nightly_logs\
REM      nightly_YYYY-MM-DD_HHMMSS.log
REM
REM  Edit PROJECT_DIR below if the checkout lives elsewhere.
REM ============================================================================

setlocal EnableDelayedExpansion

set "PROJECT_DIR=C:\Users\Administrator\Documents\billing_system"
set "EMAIL_PY=%PROJECT_DIR%\email_automation\venv\Scripts\python.exe"
set "OCR_PY=%PROJECT_DIR%\ocr_automation\venv\Scripts\python.exe"
set "LOG_DIR=%PROJECT_DIR%\nightly_logs"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM Build a sortable timestamp YYYYMMDD_HHMMSS for the log file name.
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set "DT=%%I"
set "STAMP=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%_%DT:~8,2%%DT:~10,2%%DT:~12,2%"
set "LOG_FILE=%LOG_DIR%\nightly_%STAMP%.log"

cd /d "%PROJECT_DIR%" || (
    echo could not cd to %PROJECT_DIR%
    exit /b 2
)

echo [%DATE% %TIME%] starting nightly pipeline > "%LOG_FILE%"
echo [%DATE% %TIME%] project_dir=%PROJECT_DIR% >> "%LOG_FILE%"

REM ---- Phase 1: email_automation -------------------------------------------
echo. >> "%LOG_FILE%"
echo [%DATE% %TIME%] phase 1/3: email_automation >> "%LOG_FILE%"
"%EMAIL_PY%" -m email_automation.run >> "%LOG_FILE%" 2>&1
set "EMAIL_RC=!ERRORLEVEL!"
echo [%DATE% %TIME%] email_automation exit=!EMAIL_RC! >> "%LOG_FILE%"

REM Skip OCR if email failed fatally (anything other than 0 or 30).
if not "!EMAIL_RC!"=="0" if not "!EMAIL_RC!"=="30" (
    echo [%DATE% %TIME%] email phase failed (exit=!EMAIL_RC!) — skipping OCR + PO check >> "%LOG_FILE%"
    set "OCR_RC=0"
    set "PO_RC=0"
    goto :summary
)

REM ---- Phase 2: ocr_automation ---------------------------------------------
echo. >> "%LOG_FILE%"
echo [%DATE% %TIME%] phase 2/3: ocr_automation >> "%LOG_FILE%"
"%OCR_PY%" -W ignore -m ocr_automation.run >> "%LOG_FILE%" 2>&1
set "OCR_RC=!ERRORLEVEL!"
echo [%DATE% %TIME%] ocr_automation exit=!OCR_RC! >> "%LOG_FILE%"

REM ---- Phase 3: po_check ---------------------------------------------------
REM Skip only when OCR failed fatally (40=all files failed, 99=crash) so we
REM don't generate spurious "un-invoiced" flags from half-loaded data.
if "!OCR_RC!"=="40" goto :skip_po
if "!OCR_RC!"=="99" goto :skip_po

echo. >> "%LOG_FILE%"
echo [%DATE% %TIME%] phase 3/3: po_check >> "%LOG_FILE%"
"%OCR_PY%" -W ignore -m ocr_automation.po_check >> "%LOG_FILE%" 2>&1
set "PO_RC=!ERRORLEVEL!"
echo [%DATE% %TIME%] po_check exit=!PO_RC! >> "%LOG_FILE%"
goto :summary

:skip_po
echo [%DATE% %TIME%] OCR failed (exit=!OCR_RC!) — skipping PO check >> "%LOG_FILE%"
set "PO_RC=0"

:summary
echo. >> "%LOG_FILE%"
echo [%DATE% %TIME%] finished email=!EMAIL_RC! ocr=!OCR_RC! po=!PO_RC! >> "%LOG_FILE%"

REM Surface a non-zero exit if any phase failed so Task Scheduler / monitoring
REM can flag the run.
set "RC=0"
if not "!EMAIL_RC!"=="0" if not "!EMAIL_RC!"=="30" set "RC=!EMAIL_RC!"
if not "!OCR_RC!"=="0"   if not "!OCR_RC!"=="30" set "RC=!OCR_RC!"
if not "!PO_RC!"=="0"                            set "RC=!PO_RC!"

endlocal & exit /b %RC%
