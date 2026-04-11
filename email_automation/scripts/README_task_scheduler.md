# Windows Task Scheduler setup

## Files in this folder
- `run_email_automation.bat` — wrapper that calls `python -m email_automation.run --source zoho` and writes its output to `email_automation/logs/task_scheduler_last.log`.
- `email_automation_task.xml` — Task Scheduler definition: daily trigger at **16:00** with 15-minute retry until **18:00 IST**, 1-hour execution timeout, no-overlap policy.

## One-time setup

### 1. Verify .env is configured
Open `email_automation/.env` and confirm:
- `PGHOST` / `PGPASSWORD` point to production RDS (already set)
- `IMAP_USER` = `ATM@srimukhagroup.co.in`
- `IMAP_PASSWORD` = **app-specific password** from Zoho (Settings → Security → App Passwords)
- `ALERT_RECIPIENT` = your ops address
- `ALERT_ENABLED` = `true` and SMTP_* fields filled if you want summary emails

### 2. Edit the .bat if the repo lives elsewhere
Open `run_email_automation.bat` and update `PROJECT_DIR` if the checkout path differs from `C:\Users\kausi\Documents\biling_system`.

### 3. Test the wrapper manually first
```cmd
cd C:\Users\kausi\Documents\biling_system
email_automation\scripts\run_email_automation.bat
```
Check `email_automation\logs\task_scheduler_last.log` for output.

### 4. Register the scheduled task
Open an **administrator** PowerShell or cmd:
```cmd
schtasks /Create /TN "email_automation_daily" /XML "C:\Users\kausi\Documents\biling_system\email_automation\scripts\email_automation_task.xml"
```
Or import via GUI: **Task Scheduler → Action → Import Task → select the XML**.

### 5. Verify
```cmd
schtasks /Query /TN "email_automation_daily" /V /FO LIST
```
Force an immediate run once to confirm:
```cmd
schtasks /Run /TN "email_automation_daily"
```

## Operational notes
- The script is **self-locking** — if a run is still in progress when the 15-minute retry fires, the new invocation exits immediately with a lock error and no damage is done.
- Exit codes: 0 success, 10 config/lock, 30 partial, 40 total failure, 99 unexpected.
- Task Scheduler will retry 8 times in the 2-hour window if any run exits non-zero.
- `email_automation/logs/run_<run_id>.txt` holds the per-run summary for audit.
- To disable: `schtasks /Change /TN "email_automation_daily" /DISABLE`.
