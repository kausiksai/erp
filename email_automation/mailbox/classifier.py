"""Classify incoming email attachments into one of six document types.

Strategy
    1. Primary: subject-line keyword match against SUBJECT_KEYWORDS.
       Zoho notifications follow the pattern
           "Notification - <Type>(DD-MMM-YYYY)"
       so the keyword "<Type>" is enough to decide.
    2. Secondary: filename pattern match against FILENAME_HINTS.
       Used as a tie-breaker when the subject is ambiguous or when the
       subject doesn't contain a known keyword.
    3. If nothing matches, return `doc_type=None` so the orchestrator
       parks the file in failed/unclassified/ for human review. We never
       guess — "100% accurate" means no silent misclassification.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Dict, List, Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Classification rules
# ---------------------------------------------------------------------------
DOC_TYPES = ["po", "grn", "asn", "dc", "schedule", "invoice"]

# Subject substrings (lowercased). Order matters when a single subject
# could match multiple types — more-specific phrases must come first.
SUBJECT_KEYWORDS: Dict[str, List[str]] = {
    "po": [
        "purchase order",
        "po details",
        "po master",
        "po list",
        "po report",
    ],
    "grn": [
        "grn details",
        "grn report",
        "goods receipt",
        "grn",
    ],
    "asn": [
        "advance shipment notice",
        "advanced shipment notice",
        "asn report",
        "asn details",
    ],
    "dc": [
        "dc transaction",
        "delivery challan",
        "dc report",
        "dc details",
    ],
    "schedule": [
        "supplier schedule",
        "po schedule",
        "schedule details",
        "schedule report",
    ],
    "invoice": [
        "bill register",
        "invoice register",
        "bills register",
    ],
}

# Filename regex patterns (lowercased match). Only used as a tie-breaker.
FILENAME_HINTS: Dict[str, List[str]] = {
    "po":       [r"^po[\.\s_\-]", r"purchase[_\s\-]?order"],
    "grn":      [r"^grn[\.\s_\-]", r"goods[_\s\-]?receipt"],
    "asn":      [r"^asn[\.\s_\-]", r"shipment[_\s\-]?notice"],
    "dc":       [r"^dc[\.\s_\-]", r"delivery[_\s\-]?challan"],
    "schedule": [r"^schedule", r"supplier[_\s\-]?schedule"],
    "invoice":  [r"bill[_\s\-]?register", r"^invoice"],
}


@dataclass
class ClassificationResult:
    doc_type: Optional[str]
    confidence: float   # 0..1
    reason: str         # human-readable why

    @property
    def is_confident(self) -> bool:
        return self.doc_type is not None and self.confidence >= 0.6


def _norm(s: Optional[str]) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", s).strip().lower()


def classify(subject: Optional[str], filename: Optional[str]) -> ClassificationResult:
    """Return a ClassificationResult for a single attachment.

    The function never raises. On no match it returns doc_type=None with
    `reason` explaining why.
    """
    subject_l = _norm(subject)
    filename_l = _norm(filename)

    # ---- Step 1: subject keyword match -------------------------------------
    subject_matches: Dict[str, str] = {}
    for doc_type, keywords in SUBJECT_KEYWORDS.items():
        for kw in keywords:
            if kw in subject_l:
                # Record the first (most-specific) keyword that matched
                subject_matches.setdefault(doc_type, kw)
                break

    if len(subject_matches) == 1:
        doc_type, kw = next(iter(subject_matches.items()))
        return ClassificationResult(
            doc_type=doc_type,
            confidence=1.0,
            reason=f"subject keyword '{kw}'",
        )

    if len(subject_matches) > 1:
        # Multiple subject matches — use the filename as a tiebreaker
        for doc_type in subject_matches.keys():
            for pattern in FILENAME_HINTS.get(doc_type, []):
                if re.search(pattern, filename_l):
                    return ClassificationResult(
                        doc_type=doc_type,
                        confidence=0.85,
                        reason=(
                            f"subject matched {list(subject_matches.keys())}; "
                            f"filename pattern '{pattern}' disambiguated to {doc_type}"
                        ),
                    )
        return ClassificationResult(
            doc_type=None,
            confidence=0.0,
            reason=f"ambiguous subject match: {list(subject_matches.keys())}",
        )

    # ---- Step 2: filename-only fallback ------------------------------------
    filename_matches: Dict[str, str] = {}
    for doc_type, patterns in FILENAME_HINTS.items():
        for pattern in patterns:
            if re.search(pattern, filename_l):
                filename_matches.setdefault(doc_type, pattern)
                break

    if len(filename_matches) == 1:
        doc_type, pattern = next(iter(filename_matches.items()))
        return ClassificationResult(
            doc_type=doc_type,
            confidence=0.6,
            reason=f"filename pattern '{pattern}'",
        )
    if len(filename_matches) > 1:
        return ClassificationResult(
            doc_type=None,
            confidence=0.0,
            reason=f"ambiguous filename match: {list(filename_matches.keys())}",
        )

    return ClassificationResult(
        doc_type=None,
        confidence=0.0,
        reason=f"no subject or filename match (subject={subject!r}, file={filename!r})",
    )
