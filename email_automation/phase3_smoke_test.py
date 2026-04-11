"""Phase 3 smoke test.

Runs the validation sweeper over every invoice currently in
`waiting_for_validation` or `waiting_for_re_validation` in the production
RDS and prints the bucket distribution + top error codes.

Run with:
    python -m email_automation.phase3_smoke_test

Exits 0 on completion (even if many invoices fail validation — those are
legitimate outcomes, not pipeline failures). Exits non-zero only on a
pipeline-level error (pool init, unhandled exception, etc).
"""

from __future__ import annotations

import sys
import time
import traceback
from typing import Dict

from .audit import RUN_STATUS_SUCCESS, finish_run, start_run
from .db import close_pool, get_cursor
from .logger import setup_logging
from .validation.sweeper import revalidate_pending


def _header(title: str) -> None:
    print()
    print("=" * 78)
    print(f" {title}")
    print("=" * 78)


def _status_counts() -> Dict[str, int]:
    out: Dict[str, int] = {}
    with get_cursor(readonly=True) as cur:
        cur.execute(
            """
            SELECT status, COUNT(*) AS c
            FROM invoices
            GROUP BY status
            ORDER BY status
            """
        )
        for r in cur.fetchall():
            out[r["status"]] = r["c"]
    return out


def main() -> int:
    setup_logging()

    _header("Pre-sweep status distribution")
    pre = _status_counts()
    for s, c in pre.items():
        print(f"  {s:30s}: {c:>6}")

    _header("Starting sweeper run")
    run_id = start_run()
    print(f"  run_id: {run_id}")

    t0 = time.time()
    try:
        report = revalidate_pending(run_id=run_id, log_to_audit=False)
    except Exception as exc:
        print(f"[FATAL] sweeper raised: {exc}")
        traceback.print_exc()
        return 10

    _header("Sweeper report")
    print(f"  {report.summary()}")

    _header("Post-sweep status distribution")
    post = _status_counts()
    all_statuses = sorted(set(pre) | set(post))
    for s in all_statuses:
        before = pre.get(s, 0)
        after = post.get(s, 0)
        delta = after - before
        arrow = "+" if delta >= 0 else ""
        print(f"  {s:30s}: {before:>6} -> {after:>6}  ({arrow}{delta})")

    if report.error_code_histogram:
        _header("Top validation error codes")
        for code, count in list(report.error_code_histogram.items())[:20]:
            samples = report.reason_samples.get(code, [])
            sample_s = ",".join(str(s) for s in samples[:3]) if samples else ""
            print(f"  {code:40s} {count:>6}  invoice_ids={sample_s}")

    finish_run(
        run_id,
        RUN_STATUS_SUCCESS,
        attachments_processed=report.invoices_evaluated,
        attachments_succeeded=report.validated,
        attachments_failed=report.load_errors,
        attachments_skipped=report.still_waiting,
        revalidated_invoices=report.invoices_evaluated,
    )

    _header("PHASE 3 SMOKE TEST: DONE")
    close_pool()
    return 0


if __name__ == "__main__":
    sys.exit(main())
