"""Stage 3 — flag POs that have GRNs but no raised invoice yet.

Pipeline
    1. Acquire file lock (separate from the OCR file lock).
    2. Insert a run row in `ocr_automation_runs` (re-uses the same audit
       table so the dashboard shows one unified history).
    3. Run a single SQL upsert that:
         a. Finds every PO with a recent GRN, no invoice link, and the
            most-recent GRN ≥ PO_CHECK_GRACE_DAYS old.
         b. Inserts those rows into `unraised_invoices` (or updates
            `last_seen_at` for ones already there — preserves
            `first_flagged_at`).
       Then deletes any rows that no longer qualify (the supplier finally
       sent the invoice).
    4. Finish the run row with the count flagged / cleared.

This step is pure SQL — no external API calls, takes seconds even on
millions of rows. It runs after `ocr_automation.run` so any invoices
just loaded are excluded.

Run with:
    python -m ocr_automation.po_check
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

import psycopg2

from . import audit
from .config import CONFIG
from .db import close_pool, get_conn, ping
from .logger import setup_logging

log = logging.getLogger("ocr_automation.po_check")

EXIT_OK = 0
EXIT_CONFIG = 10
EXIT_FATAL = 99


@contextmanager
def acquire_lock(path: Path):
    if path.exists():
        try:
            existing = path.read_text().strip()
        except OSError:
            existing = "?"
        raise RuntimeError(
            f"Lock file {path} already exists (pid={existing}). "
            "Another po_check run may be in progress."
        )
    try:
        path.write_text(str(os.getpid()))
    except OSError as exc:
        raise RuntimeError(f"Cannot create lock file {path}: {exc}") from exc
    try:
        yield
    finally:
        try:
            path.unlink()
        except OSError as exc:
            log.warning("could not remove lock file %s: %s", path, exc)


# ---------------------------------------------------------------------------
# The single SQL — find candidates, upsert, then delete cleared rows.
# ---------------------------------------------------------------------------
#
# Candidate definition:
#   * GRN exists for this po_id
#   * Most recent GRN is at least :grace_days old
#   * No invoice currently links to this po_id
#
# We aggregate (sum accepted_qty * unit_cost) at the GRN-line level for the
# expected_amount estimate. This is "best-effort" — the actual invoice may
# differ in tax, freight, rounding, etc., but it's a useful triage figure.
UPSERT_SQL = """
WITH grn_summary AS (
    SELECT
        g.po_id,
        MAX(g.id)                                              AS latest_grn_id,
        MAX(g.grn_date)                                        AS latest_grn_date,
        (ARRAY_AGG(g.grn_no ORDER BY g.grn_date DESC NULLS LAST))[1]
                                                               AS latest_grn_no,
        SUM(COALESCE(g.accepted_qty, 0) * COALESCE(g.unit_cost, 0))
                                                               AS expected_amount,
        MAX(g.supplier_id)                                     AS grn_supplier_id,
        MAX(g.supplier_name)                                   AS grn_supplier_name
    FROM grn g
    WHERE g.po_id IS NOT NULL
    GROUP BY g.po_id
),
candidates AS (
    SELECT
        po.po_id,
        po.po_number::text                                     AS po_number,
        COALESCE(po.supplier_id, gs.grn_supplier_id)           AS supplier_id,
        COALESCE(s.supplier_name, gs.grn_supplier_name)        AS supplier_name,
        gs.latest_grn_id,
        gs.latest_grn_no,
        gs.latest_grn_date,
        (CURRENT_DATE - gs.latest_grn_date)::int               AS days_since_grn,
        ROUND(gs.expected_amount::numeric, 2)                  AS expected_amount
    FROM purchase_orders po
    JOIN grn_summary gs ON gs.po_id = po.po_id
    LEFT JOIN suppliers s ON s.supplier_id = po.supplier_id
    LEFT JOIN invoices i ON i.po_id = po.po_id
    WHERE i.invoice_id IS NULL
      AND gs.latest_grn_date IS NOT NULL
      AND (CURRENT_DATE - gs.latest_grn_date) >= %(grace_days)s
)
INSERT INTO unraised_invoices (
    po_id, po_number, supplier_id, supplier_name,
    latest_grn_id, latest_grn_no, latest_grn_date,
    days_since_grn, expected_amount,
    first_flagged_at, last_seen_at, last_run_id
)
SELECT
    po_id, po_number, supplier_id, supplier_name,
    latest_grn_id, latest_grn_no, latest_grn_date,
    days_since_grn, expected_amount,
    NOW(), NOW(), %(run_id)s
FROM candidates
ON CONFLICT (po_id) DO UPDATE SET
    po_number       = EXCLUDED.po_number,
    supplier_id     = COALESCE(EXCLUDED.supplier_id, unraised_invoices.supplier_id),
    supplier_name   = COALESCE(EXCLUDED.supplier_name, unraised_invoices.supplier_name),
    latest_grn_id   = EXCLUDED.latest_grn_id,
    latest_grn_no   = EXCLUDED.latest_grn_no,
    latest_grn_date = EXCLUDED.latest_grn_date,
    days_since_grn  = EXCLUDED.days_since_grn,
    expected_amount = EXCLUDED.expected_amount,
    last_seen_at    = NOW(),
    last_run_id     = EXCLUDED.last_run_id
RETURNING (xmax = 0) AS was_inserted;
"""

# Anything in unraised_invoices whose PO now has an invoice gets cleared.
DELETE_RESOLVED_SQL = """
DELETE FROM unraised_invoices ui
WHERE EXISTS (
    SELECT 1 FROM invoices i WHERE i.po_id = ui.po_id
)
RETURNING ui.po_id;
"""


def _run_check(run_id: UUID, grace_days: int) -> tuple[int, int, int]:
    """Returns (newly_flagged, still_flagged, cleared)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            # 1) Clear POs that have since received an invoice
            cur.execute(DELETE_RESOLVED_SQL)
            cleared = cur.rowcount or 0
            log.info("cleared %d row(s) (invoice arrived since last run)", cleared)

            # 2) Upsert current candidates
            cur.execute(UPSERT_SQL, {"grace_days": grace_days, "run_id": str(run_id)})
            rows = cur.fetchall()
            new = sum(1 for r in rows if r[0])
            updated = len(rows) - new
            log.info(
                "po_check: newly flagged=%d, still flagged (refresh)=%d, cleared=%d",
                new, updated, cleared,
            )
            return new, updated, cleared


def _audit_summary(
    run_id: UUID, grace_days: int, new: int, updated: int, cleared: int
) -> None:
    """Write a single summary row to ocr_automation_log so the dashboard
    sees the po_check stage alongside file-level activity.
    """
    audit.log_file_event(
        run_id=run_id,
        file_id="__po_check__",
        file_name="po_check",
        status="po_check",
        details={
            "grace_days": grace_days,
            "newly_flagged": new,
            "still_flagged": updated,
            "cleared": cleared,
            "total_open": new + updated,
        },
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="PO check — un-invoiced POs")
    parser.add_argument(
        "--grace-days",
        type=int,
        default=int(os.environ.get("PO_CHECK_GRACE_DAYS", "7")),
        help="Days since latest GRN before a PO is flagged (default 7)",
    )
    args = parser.parse_args(argv)

    setup_logging()
    log.info("po_check starting (grace_days=%d)", args.grace_days)

    if not ping():
        log.error("DB ping failed; aborting")
        return EXIT_CONFIG

    lock_path = CONFIG.paths.root / ".lock.po_check"
    try:
        with acquire_lock(lock_path):
            run_id = audit.start_run(
                drive_folder_id=f"po_check(grace_days={args.grace_days})"
            )
            try:
                new, updated, cleared = _run_check(run_id, args.grace_days)
                _audit_summary(run_id, args.grace_days, new, updated, cleared)
                audit.finish_run(
                    run_id, audit.RUN_SUCCESS,
                    files_listed=new + updated,
                    files_processed=new + updated,
                    files_succeeded=new + updated,
                )
                log.info(
                    "po_check done: %d open, %d cleared", new + updated, cleared
                )
                return EXIT_OK
            except (psycopg2.Error, Exception) as exc:  # noqa: BLE001
                log.exception("po_check failed in run %s", run_id)
                audit.finish_run(
                    run_id, audit.RUN_FAILED,
                    error_message=f"{type(exc).__name__}: {exc}",
                )
                return EXIT_FATAL
    except RuntimeError as exc:
        log.error("lock error: %s", exc)
        return EXIT_CONFIG
    finally:
        close_pool()


if __name__ == "__main__":
    sys.exit(main())
