"""Batch sweeper — runs the validation engine over all invoices currently
in `waiting_for_validation` or `waiting_for_re_validation`, regardless of
source (portal or email_automation).

Per invoice, each validation runs in its own transaction so a failure on
one invoice does not roll back the rest of the sweep.
"""

from __future__ import annotations

import logging
import time
import traceback
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from uuid import UUID

import psycopg2
from psycopg2.extensions import connection as PGConnection

from ..audit import AttachmentLogEntry, STATUS_VALIDATED, log_attachment
from ..db import get_conn
from .context import ContextError
from .engine import ValidationResult, run_full_validation
from .status_writer import apply_validation_result
from .tolerances import (
    STATUS_EXCEPTION_APPROVAL,
    STATUS_VALIDATED as TGT_VALIDATED,
    STATUS_WAITING_FOR_RE_VALIDATION,
    STATUS_WAITING_FOR_VALIDATION,
)

log = logging.getLogger(__name__)


@dataclass
class SweeperReport:
    invoices_evaluated: int = 0
    validated: int = 0
    waiting_for_re_validation: int = 0
    exception_approval: int = 0
    still_waiting: int = 0
    load_errors: int = 0
    duration_seconds: float = 0.0
    error_code_histogram: Dict[str, int] = field(default_factory=dict)
    reason_samples: Dict[str, List[int]] = field(default_factory=dict)

    def summary(self) -> str:
        return (
            f"evaluated={self.invoices_evaluated} "
            f"validated={self.validated} "
            f"re_validation={self.waiting_for_re_validation} "
            f"exception={self.exception_approval} "
            f"still_waiting={self.still_waiting} "
            f"load_errors={self.load_errors} "
            f"in {self.duration_seconds:.2f}s"
        )


def _fetch_pending_ids(limit: Optional[int] = None) -> List[int]:
    # Skip invoices that still need dual-source reconciliation. Rows with
    # reconciliation_status='pending_reconciliation' have unresolved
    # Excel/OCR mismatches — validating them would use stale/ambiguous
    # values and defeat the reviewer's approval step. Once a reviewer
    # signs off (manually_approved) or the two sources agree (auto_matched)
    # they flow through normally. Legacy single-source rows are unaffected.
    with get_conn(readonly=True) as conn:
        with conn.cursor() as cur:
            sql = """
                SELECT invoice_id FROM invoices
                WHERE status IN (%s, %s)
                  AND COALESCE(reconciliation_status, 'single_source')
                      <> 'pending_reconciliation'
                ORDER BY invoice_id
            """
            params = (
                STATUS_WAITING_FOR_VALIDATION,
                STATUS_WAITING_FOR_RE_VALIDATION,
            )
            if limit is not None:
                sql += " LIMIT %s"
                params = (*params, limit)
            cur.execute(sql, params)
            return [row[0] for row in cur.fetchall()]


def revalidate_pending(
    run_id: Optional[UUID] = None,
    *,
    limit: Optional[int] = None,
    log_to_audit: bool = True,
) -> SweeperReport:
    """Run validation over all pending invoices. Returns a SweeperReport."""
    report = SweeperReport()
    t0 = time.time()

    pending_ids = _fetch_pending_ids(limit=limit)
    report.invoices_evaluated = len(pending_ids)
    log.info("sweeper: %d invoices pending validation", report.invoices_evaluated)
    if not pending_ids:
        report.duration_seconds = time.time() - t0
        return report

    code_counter: Counter = Counter()
    reason_samples: Dict[str, List[int]] = {}

    for idx, invoice_id in enumerate(pending_ids):
        try:
            with get_conn() as conn:
                result = run_full_validation(conn, invoice_id)
                apply_validation_result(conn, result)

            # Aggregate by bucket
            if result.target_status == TGT_VALIDATED:
                report.validated += 1
            elif result.target_status == STATUS_WAITING_FOR_RE_VALIDATION:
                report.waiting_for_re_validation += 1
            elif result.target_status == STATUS_EXCEPTION_APPROVAL:
                report.exception_approval += 1
            else:
                report.still_waiting += 1

            for e in result.errors:
                code_counter[e.code] += 1
                samples = reason_samples.setdefault(e.code, [])
                if len(samples) < 3:
                    samples.append(invoice_id)

            if log_to_audit and run_id is not None:
                try:
                    log_attachment(
                        AttachmentLogEntry(
                            run_id=run_id,
                            attachment_name=f"invoice:{invoice_id}",
                            doc_type="invoice",
                            status=STATUS_VALIDATED if result.valid else "failed",
                            invoice_id=invoice_id,
                            po_id=result.po_id,
                            validation_result=result.to_jsonb(),
                            error_message=result.reason if not result.valid else None,
                        )
                    )
                except Exception as exc:
                    log.warning("audit log failed for invoice %s: %s", invoice_id, exc)

        except ContextError as exc:
            report.load_errors += 1
            log.error("context load failed for invoice %s: %s", invoice_id, exc)
        except psycopg2.Error as exc:
            report.load_errors += 1
            log.error("db error on invoice %s: %s", invoice_id, exc)
        except Exception as exc:
            report.load_errors += 1
            log.error("unexpected error on invoice %s: %s", invoice_id, exc)
            log.debug(traceback.format_exc())

        if (idx + 1) % 200 == 0:
            log.info("sweeper: %d/%d processed", idx + 1, len(pending_ids))

    report.error_code_histogram = dict(code_counter.most_common())
    report.reason_samples = reason_samples
    report.duration_seconds = time.time() - t0
    log.info("sweeper complete: %s", report.summary())
    return report
