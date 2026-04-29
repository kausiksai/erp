"""Submits a downloaded PDF through the existing portal flow:

  1. POST /api/invoices/upload   (multipart upload)
       → returns extracted invoice_data + base64 pdfBuffer (plain JSON)
  2. POST /api/invoices          (JSON; saves to DB + auto-runs reconcile)
       → returns invoiceId + reconciliation result

Both endpoints already exist and are battle-tested by the portal UI; we just
drive them programmatically. This way the OCR pipeline writes ocr_snapshot
exactly the same way single uploads do, and reconciliation runs server-side.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

import requests
from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError

from .config import CONFIG

log = logging.getLogger(__name__)


class ExtractionError(RuntimeError):
    pass


class SaveError(RuntimeError):
    pass


@dataclass
class ExtractResult:
    invoice_data: Dict[str, Any]
    pdf_buffer_b64: Optional[str]
    pdf_file_name: Optional[str]
    po_id: Optional[int]
    supplier_id: Optional[int]
    extracted: bool
    extraction_error: Optional[str]


@dataclass
class SaveResult:
    invoice_id: int
    reconciliation_status: Optional[str]
    mismatches: Optional[list]


def _auth_headers() -> Dict[str, str]:
    if CONFIG.backend.auth_token:
        return {"Authorization": f"Bearer {CONFIG.backend.auth_token}"}
    return {}


def slice_pdf_to_first_n_pages(
    pdf_bytes: bytes, max_pages: int
) -> Tuple[bytes, int, int]:
    """Return (sliced_bytes, original_page_count, kept_page_count).

    If parsing fails or the PDF already has ≤ max_pages, the input is
    returned unchanged. Used to keep Landing AI Parse fast and cheap on
    multi-document scans (invoice + GRN + DC bundled in one file).
    """
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes), strict=False)
        total = len(reader.pages)
    except (PdfReadError, Exception) as exc:  # noqa: BLE001
        log.warning("could not read PDF for slicing (%s) — sending full file", exc)
        return pdf_bytes, 0, 0

    if total <= max_pages:
        return pdf_bytes, total, total

    try:
        writer = PdfWriter()
        for i in range(max_pages):
            writer.add_page(reader.pages[i])
        out = io.BytesIO()
        writer.write(out)
        sliced = out.getvalue()
        return sliced, total, max_pages
    except Exception as exc:  # noqa: BLE001
        log.warning("PDF slicing failed (%s) — sending full file", exc)
        return pdf_bytes, total, total


def extract(pdf_bytes: bytes, filename: str, mime_type: str) -> ExtractResult:
    """Step 1: send PDF to /api/invoices/upload, parse JSON result."""
    url = f"{CONFIG.backend.base_url}/invoices/upload"
    files = {"pdf": (filename, pdf_bytes, mime_type)}
    try:
        resp = requests.post(
            url,
            files=files,
            headers=_auth_headers(),
            timeout=CONFIG.backend.request_timeout,
        )
    except requests.RequestException as exc:
        raise ExtractionError(f"upload request failed: {exc}") from exc

    if resp.status_code != 200:
        raise ExtractionError(
            f"upload returned HTTP {resp.status_code}: {resp.text[:400]}"
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        raise ExtractionError(f"upload returned non-JSON body: {exc}") from exc

    return ExtractResult(
        invoice_data=payload.get("invoiceData") or {},
        pdf_buffer_b64=payload.get("pdfBuffer"),
        pdf_file_name=payload.get("pdfFileName") or filename,
        po_id=payload.get("poId"),
        supplier_id=payload.get("supplierId"),
        extracted=bool(payload.get("extracted")),
        extraction_error=payload.get("extractionError"),
    )


def save(extract_result: ExtractResult) -> SaveResult:
    """Step 2: persist as a real invoice. Reconcile runs server-side."""
    inv = extract_result.invoice_data or {}
    body: Dict[str, Any] = {
        "invoiceNumber": inv.get("invoiceNumber") or None,
        "invoiceDate": inv.get("invoiceDate") or None,
        "supplierId": extract_result.supplier_id,
        "poId": extract_result.po_id,
        "poNumber": inv.get("poNumber") or None,
        "supplierGstin": inv.get("supplierGstin") or None,
        "supplierName": inv.get("supplierName") or None,
        "scanningNumber": None,
        "subtotal": inv.get("subtotal"),
        "cgst": inv.get("cgst"),
        "sgst": inv.get("sgst"),
        "igst": inv.get("igst"),
        "taxAmount": inv.get("taxAmount"),
        "totalAmount": inv.get("totalAmount"),
        "status": "waiting_for_validation",
        "notes": None,
        "items": inv.get("items") or [],
        "pdfFileName": extract_result.pdf_file_name,
        "pdfBuffer": extract_result.pdf_buffer_b64,
    }

    url = f"{CONFIG.backend.base_url}/invoices"
    headers = {"Content-Type": "application/json", **_auth_headers()}
    try:
        resp = requests.post(
            url,
            json=body,
            headers=headers,
            timeout=CONFIG.backend.request_timeout,
        )
    except requests.RequestException as exc:
        raise SaveError(f"save request failed: {exc}") from exc

    if resp.status_code != 200:
        raise SaveError(f"save returned HTTP {resp.status_code}: {resp.text[:400]}")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise SaveError(f"save returned non-JSON body: {exc}") from exc

    invoice_id = payload.get("invoiceId")
    if invoice_id is None:
        raise SaveError(f"save did not return invoiceId: {payload}")

    recon = payload.get("reconciliation") or {}
    return SaveResult(
        invoice_id=int(invoice_id),
        reconciliation_status=recon.get("reconciliation_status"),
        mismatches=recon.get("mismatches"),
    )
