"""Validation engine for the billing system.

This package is the single source of truth for invoice validation. It is
invoked by:
    * The email automation sweeper on every run (for new and pending invoices)
    * A separate cron/daemon for portal-uploaded invoices (future Phase 3.5)

Public entry points
    run_full_validation(conn, invoice_id)        -> ValidationResult
    apply_validation_result(conn, result)        -> None
    revalidate_pending(conn, run_id)             -> SweeperReport

Design principles
    * Pure-function checks: every check takes an `InvoiceContext` and returns
      a list of `Finding` records (error | warning with an explicit code).
    * The engine does not write to the DB; `status_writer` does.
    * Each check has a stable code (E001_..., W001_...) so the bucket report
      is grep-able and stable across runs.
    * The engine re-implements the Node `runFullValidation` behaviour AND
      adds every gap-list validation noted in the project memory.
"""

from .engine import ValidationResult, run_full_validation  # noqa: F401
from .sweeper import SweeperReport, revalidate_pending  # noqa: F401
from .status_writer import apply_validation_result  # noqa: F401
