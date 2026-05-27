"""Read-only Python dry-run — calls run_full_validation() on every pending
invoice and counts what target_status Python would produce. Nothing is
written to the database.

Run:
    cd erp
    python -m email_automation.dry_run_python_validator

Same purpose as backend/scripts/dry_run_validation.js — gives the
apples-to-apples Python count so we can confirm both engines now produce
the same number under the current rule set.
"""
from __future__ import annotations
import sys
from collections import Counter
from .db import get_conn
from .validation.engine import run_full_validation
from .validation.tolerances import (
    STATUS_VALIDATED,
    STATUS_WAITING_FOR_VALIDATION,
    STATUS_WAITING_FOR_RE_VALIDATION,
    STATUS_EXCEPTION_APPROVAL,
)


def main() -> int:
    # Mirror Python sweeper scope: pending statuses + validated rows
    # that haven't been approved for payment yet. Locked rows
    # (ready_for_payment / paid / rejected / validated-with-PA) are
    # excluded — they're past the validation gate.
    eligible_statuses = (
        STATUS_WAITING_FOR_VALIDATION,
        STATUS_WAITING_FOR_RE_VALIDATION,
        STATUS_EXCEPTION_APPROVAL,
        "debit_note_approval",
        STATUS_VALIDATED,
    )

    with get_conn(readonly=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT i.invoice_id FROM invoices i
                LEFT JOIN payment_approvals pa ON pa.invoice_id = i.invoice_id
                WHERE i.status = ANY(%s)
                  AND (i.status <> %s OR pa.id IS NULL)
                ORDER BY i.invoice_id
                """,
                (list(eligible_statuses), STATUS_VALIDATED),
            )
            ids = [r[0] for r in cur.fetchall()]

    print(f"\nDry-running Python validator on {len(ids)} pending invoices...\n", flush=True)

    tally = Counter()
    code_counter: Counter = Counter()
    failed = 0

    for i, inv_id in enumerate(ids, 1):
        if i % 200 == 0:
            print(f"  ...{i}/{len(ids)}", flush=True)
        try:
            with get_conn() as conn:
                result = run_full_validation(conn, inv_id)
            tally[result.target_status] += 1
            seen_codes = set()
            for e in result.errors:
                # Group by short prefix (E022, E060, ...) like JS does
                code = e.code.split("_")[0]
                seen_codes.add(code)
            for code in seen_codes:
                code_counter[code] += 1
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  ! invoice {inv_id} threw: {exc}", flush=True)

    print("\n============= PYTHON DRY-RUN OUTCOMES =============")
    print(f"Would validate (target='validated'):           {tally.get(STATUS_VALIDATED, 0)}")
    print(f"Would move to exception_approval:              {tally.get(STATUS_EXCEPTION_APPROVAL, 0)}")
    print(f"Would move to waiting_for_re_validation:       {tally.get(STATUS_WAITING_FOR_RE_VALIDATION, 0)}")
    print(f"Would stay waiting_for_validation (retry):     {tally.get(STATUS_WAITING_FOR_VALIDATION, 0)}")
    print(f"Failed to evaluate (engine threw):             {failed}")
    print(f"-----")
    print(f"Total pending evaluated:                       {len(ids)}")

    print("\n============= PYTHON ERRORS BY CODE =============")
    for code, n in code_counter.most_common():
        print(f"  {code:6s} {n:5d}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
