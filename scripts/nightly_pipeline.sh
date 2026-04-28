#!/bin/bash
# ============================================================================
# Nightly automation pipeline:
#   1. email_automation  — pulls Excel attachments, loads invoices.excel_snapshot
#   2. ocr_automation    — pulls Drive PDFs, loads invoices.ocr_snapshot
#                          (reconciliation runs server-side automatically)
#
# Exit codes from each phase are captured. OCR runs only if email succeeded
# or only partially failed (some loaded). If email fails fatally we skip OCR
# so we don't reconcile against half-loaded data.
# ============================================================================

set -u  # treat unset vars as errors; do NOT use -e because we want to inspect
        # phase exit codes manually.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Use the system python; override via $PYTHON if needed.
PY="${PYTHON:-python3}"

echo "[nightly_pipeline] starting at $(date '+%Y-%m-%d %H:%M:%S')"
echo "[nightly_pipeline] repo=$REPO_ROOT"
echo "[nightly_pipeline] python=$PY"

# ---- Phase 1: email automation -----------------------------------------------
echo "[nightly_pipeline] phase 1/2: email_automation"
"$PY" -m email_automation.run
EMAIL_EXIT=$?
echo "[nightly_pipeline] email_automation exit=$EMAIL_EXIT"

# email_automation exit codes:
#   0  = success (all OK)
#   30 = partial success
# anything else = skip OCR
case $EMAIL_EXIT in
  0|30)
    echo "[nightly_pipeline] proceeding to OCR phase"
    ;;
  *)
    echo "[nightly_pipeline] email phase failed (exit=$EMAIL_EXIT) — skipping OCR"
    exit $EMAIL_EXIT
    ;;
esac

# ---- Phase 2: OCR automation -------------------------------------------------
echo "[nightly_pipeline] phase 2/2: ocr_automation"
"$PY" -m ocr_automation.run
OCR_EXIT=$?
echo "[nightly_pipeline] ocr_automation exit=$OCR_EXIT"

echo "[nightly_pipeline] finished at $(date '+%Y-%m-%d %H:%M:%S')"

# Surface the worst exit code so cron/systemd can alert on either phase failing.
if [ $OCR_EXIT -ne 0 ]; then
  exit $OCR_EXIT
fi
exit $EMAIL_EXIT
