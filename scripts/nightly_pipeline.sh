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
echo "[nightly_pipeline] phase 2/3: ocr_automation"
"$PY" -m ocr_automation.run
OCR_EXIT=$?
echo "[nightly_pipeline] ocr_automation exit=$OCR_EXIT"

# ---- Phase 3: PO check -------------------------------------------------------
# Always run, even if OCR was partial — po_check works against whatever the
# email + OCR phases managed to load. Skip only if OCR failed fatally
# (exit 40 = all OCR files failed) so we don't flag POs spuriously.
if [ $OCR_EXIT -eq 40 ] || [ $OCR_EXIT -eq 99 ]; then
  echo "[nightly_pipeline] OCR phase failed fatally (exit=$OCR_EXIT) — skipping PO check"
  PO_CHECK_EXIT=0
else
  echo "[nightly_pipeline] phase 3/3: po_check"
  "$PY" -m ocr_automation.po_check
  PO_CHECK_EXIT=$?
  echo "[nightly_pipeline] po_check exit=$PO_CHECK_EXIT"
fi

echo "[nightly_pipeline] finished at $(date '+%Y-%m-%d %H:%M:%S')"

# Surface the worst exit code so cron/systemd can alert on any phase failing.
WORST=0
[ $EMAIL_EXIT     -ne 0 ] && WORST=$EMAIL_EXIT
[ $OCR_EXIT       -ne 0 ] && WORST=$OCR_EXIT
[ $PO_CHECK_EXIT  -ne 0 ] && WORST=$PO_CHECK_EXIT
exit $WORST
