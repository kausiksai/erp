@echo off
REM ============================================================================
REM  run_email_automation.bat
REM  Windows Task Scheduler wrapper for the email automation pipeline.
REM  Edit the PROJECT_DIR line below if the checkout lives somewhere else.
REM ============================================================================

setlocal
set "PROJECT_DIR=C:\Users\kausi\Documents\biling_system"
set "LOG_FILE=%PROJECT_DIR%\email_automation\logs\task_scheduler_last.log"
set "PYTHON=python"

cd /d "%PROJECT_DIR%" || (
    echo [%DATE% %TIME%] could not cd to %PROJECT_DIR% >> "%LOG_FILE%"
    exit /b 2
)

echo [%DATE% %TIME%] starting email_automation run > "%LOG_FILE%"
"%PYTHON%" -m email_automation.run --source zoho >> "%LOG_FILE%" 2>&1
set "RC=%ERRORLEVEL%"
echo [%DATE% %TIME%] finished with exit code %RC% >> "%LOG_FILE%"
exit /b %RC%
