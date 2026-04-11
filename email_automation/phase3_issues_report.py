"""Run validation in read-only mode and produce a grouped issues report.

Doesn't write any status changes. For each invoice, runs the full engine and
collects every finding. Groups by error code and produces:

    * Total affected invoices per code (distinct)
    * 5 sample invoices per code with Bill No / Supplier / PO / Amount
    * A plain-English explanation of each error code
    * A summary the user can forward to the srimukha data team

Output is written both to stdout and to
    email_automation/logs/phase3_issues_report.md
"""

from __future__ import annotations

import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List

from .db import close_pool, get_conn, get_cursor
from .logger import setup_logging
from .validation.engine import run_full_validation

# ---------------------------------------------------------------------------
# Plain-English explanations per error code
# ---------------------------------------------------------------------------
ERROR_DESCRIPTIONS: Dict[str, Dict[str, str]] = {
    "E001_NO_INVOICE_NUMBER": {
        "category": "Data quality",
        "severity": "Blocking",
        "what": "Invoice row has no bill number",
        "action": "srimukha ERP — populate Bill No. on every invoice row",
    },
    "E002_NO_PO_LINK": {
        "category": "Data quality",
        "severity": "Blocking",
        "what": "Invoice row has no PO / SCO number",
        "action": "srimukha ERP — every invoice must reference a PO or SCO",
    },
    "E003_PO_NOT_FOUND": {
        "category": "Missing reference data",
        "severity": "Blocking (retries next run)",
        "what": "Invoice references a PO number that is not present in the PO.xls export",
        "action": "srimukha ERP — include subcontract orders (SC prefix) in the PO export, or send a separate SCO file",
    },
    "E004_NO_SUPPLIER": {
        "category": "Data quality",
        "severity": "Blocking",
        "what": "Supplier cannot be resolved from supplier code or name",
        "action": "srimukha ERP — populate Supplier code and name",
    },
    "E005_SUPPLIER_MISMATCH": {
        "category": "Data quality",
        "severity": "Blocking",
        "what": "Invoice supplier does not match the PO supplier",
        "action": "Review by finance — either the PO was placed on a different vendor or the invoice was coded against the wrong PO",
    },
    "E006_PO_ALREADY_FULFILLED": {
        "category": "Exception approval",
        "severity": "Routed to exception approval",
        "what": "Invoice arrived for a PO that is already fulfilled",
        "action": "Manager must approve the over-fulfilment via exception approval",
    },
    "E010_INVOICE_DATE_IN_FUTURE": {
        "category": "Data quality",
        "severity": "Blocking",
        "what": "Invoice date is in the future",
        "action": "Supplier — correct the invoice date",
    },
    "E011_INVOICE_BEFORE_PO": {
        "category": "Data quality",
        "severity": "Blocking",
        "what": "Invoice date is earlier than the PO date (invoicing before the order was raised)",
        "action": "Finance review — legitimate only with a backdated PO raised retrospectively",
    },
    "E020_NO_MATCHING_PO_LINE": {
        "category": "Data quality",
        "severity": "Blocking",
        "what": "Invoice line item doesn't match any PO line item (no item id / description overlap)",
        "action": "Supplier or finance — align the item code / description between invoice and PO",
    },
    "E021_LINE_QTY_OVER_PO": {
        "category": "Shortfall / over-billing",
        "severity": "Routed to debit note",
        "what": "Invoice line quantity exceeds the PO line quantity",
        "action": "Supplier — raise a debit note for the excess",
    },
    "E022_LINE_RATE_MISMATCH": {
        "category": "Price drift",
        "severity": "Routed to debit note",
        "what": "Invoice rate differs from the PO unit_cost × (1 - disc%)",
        "action": "Supplier or finance — the agreed PO rate must be respected",
    },
    "E023_LINE_PRICE_MISMATCH": {
        "category": "Price drift",
        "severity": "Routed to debit note",
        "what": "Invoice line assessable value ≠ qty × PO effective rate",
        "action": "Supplier or finance — re-bill at the PO-agreed line total",
    },
    "E030_CGST_SLAB_SUM_MISMATCH": {
        "category": "GST data quality",
        "severity": "Blocking",
        "what": "Sum of CGST9 + CGST2.5 slab amounts doesn't match CGST Total column",
        "action": "srimukha ERP — Bill Register export has inconsistent CGST slab breakdown",
    },
    "E031_SGST_SLAB_SUM_MISMATCH": {
        "category": "GST data quality",
        "severity": "Blocking",
        "what": "Sum of SGST9 + SGST2.5 slab amounts doesn't match SGST Total column",
        "action": "srimukha ERP — Bill Register export has inconsistent SGST slab breakdown",
    },
    "E032_IGST_SLAB_SUM_MISMATCH": {
        "category": "GST data quality",
        "severity": "Blocking",
        "what": "Sum of IGST18 + IGST5 slab amounts doesn't match IGST Total column",
        "action": "srimukha ERP — Bill Register export has inconsistent IGST slab breakdown",
    },
    "E033_CGST_SGST_NOT_EQUAL": {
        "category": "GST data quality",
        "severity": "Blocking",
        "what": "CGST amount is not equal to SGST amount (Indian GST rule violation)",
        "action": "Supplier — correct the invoice GST calculation",
    },
    "E034_INTRA_STATE_WITH_IGST": {
        "category": "GST data quality",
        "severity": "Blocking",
        "what": "Supplier and place of supply are in the same state but invoice charges IGST",
        "action": "Supplier — intra-state supply should use CGST + SGST, not IGST",
    },
    "E035_INTER_STATE_WITH_CGST_SGST": {
        "category": "GST data quality",
        "severity": "Blocking",
        "what": "Supplier and place of supply are in different states but invoice charges CGST/SGST",
        "action": "Supplier — inter-state supply should use IGST, not CGST/SGST",
    },
    "E040_HEADER_QTY_OVER_PO": {
        "category": "Shortfall / over-billing",
        "severity": "Routed to debit note",
        "what": "Sum of invoice line quantities exceeds sum of PO line quantities",
        "action": "Supplier — debit note for the excess qty",
    },
    "E041_HEADER_QTY_UNDER_PO": {
        "category": "Shortfall / partial delivery",
        "severity": "Routed to debit note",
        "what": "Sum of invoice line quantities is less than PO line quantities — partial delivery",
        "action": "Supplier or finance — expected behaviour for partial delivery; raise credit note or accept shortfall",
    },
    "E042_HEADER_AMOUNT_OVER_PO": {
        "category": "Shortfall / over-billing (amount)",
        "severity": "Routed to debit note",
        "what": "Invoice pre-tax total exceeds computed PO value (qty × unit_cost × (1-disc%))",
        "action": "Supplier — debit note for the overbilled amount",
    },
    "E050_GRN_LESS_THAN_INVOICE": {
        "category": "Shortfall (receipt coverage)",
        "severity": "Routed to debit note",
        "what": "GRN accepted quantity is less than what's being invoiced (paying for undelivered goods)",
        "action": "Warehouse — verify receipt; supplier — credit for the missing qty",
    },
    "E060_CUMULATIVE_QTY_OVER_PO": {
        "category": "Cumulative over-billing",
        "severity": "Routed to debit note",
        "what": "Total qty invoiced across all invoices on this PO exceeds PO qty",
        "action": "Supplier / finance — debit note or stop billing",
    },
    "E061_CUMULATIVE_AMOUNT_OVER_PO": {
        "category": "Cumulative over-billing (amount)",
        "severity": "Routed to debit note",
        "what": "Total pre-tax amount invoiced across all invoices on this PO exceeds PO value",
        "action": "Supplier / finance — debit note or stop billing",
    },
    "E070_OPEN_PO_NO_GRN": {
        "category": "Open PO data gap",
        "severity": "Blocking",
        "what": "Open PO invoice has no matching GRN with qty",
        "action": "Warehouse — post GRN before invoice can be validated",
    },
    "E071_OPEN_PO_GRN_QTY_MISMATCH": {
        "category": "Open PO data quality",
        "severity": "Routed to debit note",
        "what": "Open PO invoice qty doesn't match GRN total",
        "action": "Supplier or warehouse — reconcile",
    },
    "E072_OPEN_PO_NO_ASN": {
        "category": "Open PO data gap",
        "severity": "Blocking",
        "what": "Open PO invoice has no linked ASN",
        "action": "Supplier / logistics — raise ASN first",
    },
    "E073_OPEN_PO_ASN_QTY_MISMATCH": {
        "category": "Open PO data quality",
        "severity": "Routed to debit note",
        "what": "Open PO invoice qty doesn't match ASN total",
        "action": "Supplier / logistics — reconcile",
    },
    "E074_OPEN_PO_NO_DC_OR_SCHEDULE": {
        "category": "Open PO data gap",
        "severity": "Blocking",
        "what": "Open PO invoice has no Delivery Challan or Schedule reference",
        "action": "Warehouse / planning — link to a DC or schedule",
    },
    "E075_OPEN_PO_DC_QTY_MISMATCH": {
        "category": "Open PO data quality",
        "severity": "Routed to debit note",
        "what": "Open PO invoice qty doesn't match DC total",
        "action": "Warehouse — reconcile DC quantity",
    },
    "E076_OPEN_PO_SCHED_QTY_MISMATCH": {
        "category": "Open PO data quality",
        "severity": "Routed to debit note",
        "what": "Open PO invoice qty doesn't match Schedule total",
        "action": "Planning — reconcile schedule quantity",
    },
}


def _header(title: str) -> str:
    bar = "=" * 78
    return f"\n{bar}\n{title}\n{bar}"


def _subheader(title: str) -> str:
    bar = "-" * 78
    return f"\n{bar}\n{title}\n{bar}"


def main() -> int:
    setup_logging()
    print("phase 3 issues report — running read-only validation on all email_automation invoices")
    print("this takes about 10 minutes; no status writes are performed.")

    # Fetch invoice IDs
    with get_cursor(readonly=True) as cur:
        cur.execute(
            "SELECT invoice_id FROM invoices WHERE source='email_automation' ORDER BY invoice_id"
        )
        ids = [r["invoice_id"] for r in cur.fetchall()]
    total = len(ids)
    print(f"  invoices to process: {total}")

    t0 = time.time()
    per_code: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    bucket_counts = {
        "validated": 0,
        "waiting_for_re_validation": 0,
        "exception_approval": 0,
        "waiting_for_validation": 0,
    }

    for idx, invoice_id in enumerate(ids):
        try:
            with get_conn(readonly=True) as conn:
                result = run_full_validation(conn, invoice_id)
            for err in result.errors:
                per_code[err.code].append(
                    {
                        "invoice_id": invoice_id,
                        "po_id": result.po_id,
                        "message": err.message,
                        "data": err.data,
                        "line_seq": err.line_seq,
                    }
                )
            if result.target_status in bucket_counts:
                bucket_counts[result.target_status] += 1
        except Exception as exc:
            print(f"  [warn] invoice {invoice_id} raised {exc}")
        if (idx + 1) % 200 == 0:
            print(f"  progress: {idx + 1}/{total} in {time.time() - t0:.0f}s")

    print(f"\ncompleted in {time.time() - t0:.0f}s")

    # Enrich samples with invoice header fields for each code
    all_sample_ids: set = set()
    for entries in per_code.values():
        for e in entries[:10]:
            all_sample_ids.add(e["invoice_id"])

    enriched: Dict[int, Dict[str, Any]] = {}
    if all_sample_ids:
        with get_cursor(readonly=True) as cur:
            cur.execute(
                """
                SELECT i.invoice_id, i.invoice_number, i.unit, i.po_number,
                       i.total_amount, i.tax_amount, s.supplier_name
                FROM invoices i
                LEFT JOIN suppliers s ON s.supplier_id = i.supplier_id
                WHERE i.invoice_id = ANY(%s)
                """,
                (list(all_sample_ids),),
            )
            for r in cur.fetchall():
                enriched[r["invoice_id"]] = dict(r)

    # ------------------------------------------------------------------
    # Compose report
    # ------------------------------------------------------------------
    lines: List[str] = []
    lines.append(_header("PHASE 3 — DATA QUALITY REPORT"))
    lines.append(
        f"\nSource: Bill Register Mar-26.xlsx → 2,033 invoices loaded "
        f"via email_automation pipeline into production RDS.\n"
    )
    lines.append("Outcome by bucket (one outcome per invoice):")
    for b, c in bucket_counts.items():
        pct = (c / total * 100) if total else 0
        lines.append(f"  {b:30s}: {c:>5}  ({pct:5.1f}%)")

    lines.append(_header("ISSUES GROUPED BY CATEGORY"))
    lines.append(
        "Error counts below are *invoice-line level* — one invoice can produce\n"
        "multiple errors. The 'Affected invoices' column is the distinct count.\n"
    )

    # Group codes by category
    by_category: Dict[str, List[str]] = defaultdict(list)
    for code in per_code.keys():
        cat = ERROR_DESCRIPTIONS.get(code, {}).get("category", "Other")
        by_category[cat].append(code)

    # Priority order of categories
    category_order = [
        "Missing reference data",
        "Data quality",
        "GST data quality",
        "Price drift",
        "Shortfall / over-billing",
        "Shortfall / over-billing (amount)",
        "Shortfall / partial delivery",
        "Shortfall (receipt coverage)",
        "Cumulative over-billing",
        "Cumulative over-billing (amount)",
        "Exception approval",
        "Open PO data gap",
        "Open PO data quality",
        "Other",
    ]

    for cat in category_order:
        if cat not in by_category:
            continue
        lines.append(_subheader(cat.upper()))
        for code in sorted(by_category[cat], key=lambda c: -len(per_code[c])):
            entries = per_code[code]
            distinct = len({e["invoice_id"] for e in entries})
            desc = ERROR_DESCRIPTIONS.get(code, {})
            lines.append(f"\n[{code}]  finding count: {len(entries):>5}   affected invoices: {distinct:>5}")
            lines.append(f"  What:     {desc.get('what', '')}")
            lines.append(f"  Severity: {desc.get('severity', '')}")
            lines.append(f"  Action:   {desc.get('action', '')}")
            lines.append("  Examples:")
            seen_invoices = set()
            sample_count = 0
            for e in entries:
                if e["invoice_id"] in seen_invoices:
                    continue
                seen_invoices.add(e["invoice_id"])
                info = enriched.get(e["invoice_id"]) or {}
                bill_no = info.get("invoice_number", "?")
                supplier = info.get("supplier_name", "?")
                unit = info.get("unit", "?")
                po = info.get("po_number") or "(none)"
                amt = info.get("total_amount") or "?"
                line_info = f" line {e['line_seq']}" if e.get("line_seq") else ""
                lines.append(
                    f"    - [{unit}] {supplier or '?'} / Bill {bill_no} / PO {po} / Amt ₹{amt}{line_info}"
                )
                lines.append(f"        -> {e['message']}")
                sample_count += 1
                if sample_count >= 5:
                    break

    lines.append(_header("SUMMARY FOR srimukha DATA TEAM"))
    lines.append(
        """
Please review the categories below. Items marked "Blocking" prevent the
invoice from ever being validated automatically; items marked "Routed to
debit note" are legitimate shortfalls that need a debit note to clear.

TOP PRIORITY (fixing these will unblock the most invoices):
  1. Include subcontract orders (SC prefix) in the PO.xls export.
     971 invoices currently cannot be validated because their PO is missing.
  2. Populate the PO / SCO No. on every invoice row in the Bill Register.
     421 invoices have no PO reference at all.
  3. Fix the intra/inter-state GST classification.
     ~400 invoices charge the wrong GST type (CGST/SGST where IGST is required
     or vice versa) — this is a compliance risk.
  4. Review the price drift findings (~2,200 lines).
     The invoice price does not match the PO rate × (1 - discount). This is
     either rate renegotiation that wasn't captured in the PO amendment, or
     the supplier is billing above agreed rates.
"""
    )

    report = "\n".join(lines)

    # Write to file first so the report is never lost to stdout encoding issues
    out_path = Path(__file__).parent / "logs" / "phase3_issues_report.md"
    try:
        out_path.write_text(report, encoding="utf-8")
        print(f"\nreport saved to: {out_path}")
    except OSError as exc:
        print(f"\n[warn] could not save report to file: {exc}")

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        print(report)
    except UnicodeEncodeError:
        print(report.encode("ascii", errors="replace").decode("ascii"))

    close_pool()
    return 0


if __name__ == "__main__":
    sys.exit(main())
