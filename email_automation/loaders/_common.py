"""Shared loader primitives.

* `LoadResult` — uniform return type for every loader so the orchestrator
  can aggregate counts across files.
* `SupplierResolver` — maps supplier codes ('V2375') + names to supplier_id
  with a local cache and progressive enrichment.
* `POResolver` — maps (po_number, amd_no) to po_id; always picks the latest
  amendment for an unqualified po_number lookup.
* `bulk_insert` — thin wrapper around psycopg2.extras.execute_values for
  fast multi-row inserts with column names.

The resolvers hold a cache per-instance, so create a new one per load.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from psycopg2.extensions import connection as PGConnection
from psycopg2.extras import execute_values

log = logging.getLogger(__name__)


@dataclass
class LoadResult:
    doc_type: str
    rows_processed: int = 0
    rows_inserted: int = 0
    rows_updated: int = 0
    rows_skipped: int = 0
    duration_seconds: float = 0.0
    extras: Dict[str, Any] = field(default_factory=dict)

    def summary(self) -> str:
        base = (
            f"{self.doc_type}: processed={self.rows_processed} "
            f"inserted={self.rows_inserted} updated={self.rows_updated} "
            f"skipped={self.rows_skipped} in {self.duration_seconds:.2f}s"
        )
        if self.extras:
            base += f" extras={self.extras}"
        return base


# ---------------------------------------------------------------------------
# Bulk insert
# ---------------------------------------------------------------------------
def bulk_insert(
    cur: Any,
    table: str,
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
    *,
    on_conflict: Optional[str] = None,
    returning: Optional[str] = None,
    page_size: int = 500,
) -> List[Tuple[Any, ...]]:
    """Insert many rows using execute_values.

    If `returning` is provided the function returns the rows from RETURNING;
    otherwise an empty list.
    """
    if not rows:
        return []
    col_list = ", ".join(f'"{c}"' for c in columns)
    sql = f'INSERT INTO {table} ({col_list}) VALUES %s'
    if on_conflict:
        sql += f" {on_conflict}"
    if returning:
        sql += f" RETURNING {returning}"
    result = execute_values(
        cur,
        sql,
        rows,
        template=None,
        page_size=page_size,
        fetch=bool(returning),
    )
    return result or []


# ---------------------------------------------------------------------------
# Supplier resolution
# ---------------------------------------------------------------------------
class SupplierResolver:
    """Resolve supplier codes/names to `suppliers.supplier_id`.

    Resolution order for each lookup:
        1. Cache hit by code.
        2. Cache hit by normalised name.
        3. DB lookup by suppliers.suplr_id.
        4. DB lookup by LOWER(TRIM(suppliers.supplier_name)).
        5. INSERT a new supplier row with code + name.

    Resolution is progressive: if the DB row exists with a NULL suplr_id and
    we find it via name, the resolver updates that row to set suplr_id.
    """

    def __init__(self, conn: PGConnection) -> None:
        self.conn = conn
        self._by_code: Dict[str, int] = {}
        self._by_name: Dict[str, int] = {}
        self.stats = {
            "cache_hits_code": 0,
            "cache_hits_name": 0,
            "db_hits_code": 0,
            "db_hits_name": 0,
            "created": 0,
            "enriched": 0,
        }

    @staticmethod
    def _norm_name(name: Optional[str]) -> Optional[str]:
        if not name:
            return None
        return " ".join(name.strip().split()).lower()

    def prefetch(self) -> None:
        """Pre-load all suppliers into the cache to avoid per-row DB hits.

        For typical runs the suppliers table is small (a few thousand rows),
        so the one-shot fetch is cheap and eliminates N network round-trips.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT supplier_id, suplr_id, supplier_name FROM suppliers"
            )
            for row in cur.fetchall():
                supplier_id, suplr_id, name = row
                if suplr_id:
                    self._by_code[suplr_id.strip()] = supplier_id
                norm = self._norm_name(name)
                if norm:
                    self._by_name.setdefault(norm, supplier_id)
        log.debug(
            "supplier prefetch: codes=%d names=%d",
            len(self._by_code),
            len(self._by_name),
        )

    def resolve(
        self,
        suplr_code: Optional[str],
        supplier_name: Optional[str],
    ) -> Optional[int]:
        """Return supplier_id, creating the supplier if necessary.

        Returns None only when both code and name are empty.
        """
        code = suplr_code.strip() if suplr_code else None
        name = supplier_name.strip() if supplier_name else None
        if not code and not name:
            return None

        norm = self._norm_name(name)

        # 1) cache by code
        if code and code in self._by_code:
            self.stats["cache_hits_code"] += 1
            return self._by_code[code]

        # 2) cache by name
        if norm and norm in self._by_name:
            supplier_id = self._by_name[norm]
            self.stats["cache_hits_name"] += 1
            # enrich cache with the code we just learned
            if code:
                self._by_code[code] = supplier_id
                self._enrich_code(supplier_id, code)
            return supplier_id

        # 3) DB lookup by code
        if code:
            with self.conn.cursor() as cur:
                cur.execute(
                    "SELECT supplier_id, supplier_name FROM suppliers WHERE suplr_id = %s",
                    (code,),
                )
                row = cur.fetchone()
                if row:
                    supplier_id, existing_name = row
                    self._by_code[code] = supplier_id
                    if existing_name:
                        self._by_name[self._norm_name(existing_name)] = supplier_id
                    self.stats["db_hits_code"] += 1
                    return supplier_id

        # 4) DB lookup by name
        if name:
            with self.conn.cursor() as cur:
                cur.execute(
                    "SELECT supplier_id, suplr_id FROM suppliers "
                    "WHERE LOWER(TRIM(supplier_name)) = LOWER(TRIM(%s))",
                    (name,),
                )
                row = cur.fetchone()
                if row:
                    supplier_id, existing_code = row
                    if norm:
                        self._by_name[norm] = supplier_id
                    if code and not existing_code:
                        self._enrich_code(supplier_id, code)
                        self._by_code[code] = supplier_id
                    elif existing_code:
                        self._by_code[existing_code] = supplier_id
                    self.stats["db_hits_name"] += 1
                    return supplier_id

        # 5) Insert new supplier
        return self._create(code, name)

    def _enrich_code(self, supplier_id: int, code: str) -> None:
        """Attach a code to an existing supplier row (best-effort)."""
        try:
            with self.conn.cursor() as cur:
                cur.execute(
                    "UPDATE suppliers SET suplr_id = %s, updated_at = NOW() "
                    "WHERE supplier_id = %s AND (suplr_id IS NULL OR suplr_id = '')",
                    (code, supplier_id),
                )
                if cur.rowcount:
                    self.stats["enriched"] += 1
        except Exception as exc:
            log.warning("supplier enrich failed id=%s code=%s: %s", supplier_id, code, exc)

    def _create(self, code: Optional[str], name: Optional[str]) -> int:
        display_name = name or (f"Unknown {code}" if code else "Unknown")
        with self.conn.cursor() as cur:
            # Handle race / name collision: if the unique name already exists,
            # fall back to selecting it.
            cur.execute(
                """
                INSERT INTO suppliers (supplier_name, suplr_id)
                VALUES (%s, %s)
                ON CONFLICT (supplier_name) DO UPDATE
                    SET suplr_id = COALESCE(suppliers.suplr_id, EXCLUDED.suplr_id),
                        updated_at = NOW()
                RETURNING supplier_id
                """,
                (display_name, code),
            )
            supplier_id = cur.fetchone()[0]
        if code:
            self._by_code[code] = supplier_id
        norm = self._norm_name(display_name)
        if norm:
            self._by_name[norm] = supplier_id
        self.stats["created"] += 1
        return supplier_id


# ---------------------------------------------------------------------------
# PO resolution
# ---------------------------------------------------------------------------
class POResolver:
    """Resolve (po_number, amd_no) to po_id.

    Caches the result of every lookup for the duration of a single run.
    For amendment-agnostic lookups (only po_number) returns the po_id of the
    latest amendment.
    """

    def __init__(self, conn: PGConnection) -> None:
        self.conn = conn
        self._by_key: Dict[Tuple[str, int], int] = {}
        self._latest: Dict[str, int] = {}

    def prefetch(self) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT po_id, po_number, amd_no FROM purchase_orders"
            )
            for row in cur.fetchall():
                po_id, po_number, amd_no = row
                amd = int(amd_no or 0)
                key = (po_number, amd)
                self._by_key[key] = po_id
                prev = self._latest.get(po_number)
                if prev is None:
                    self._latest[po_number] = po_id
                else:
                    # maintain latest by comparing amd_no via cached keys
                    # We don't know prev's amd_no without another lookup; resolve
                    # lazily on demand. For prefetch correctness, re-do a scan.
                    pass
            # second pass to compute latest deterministically
            self._latest.clear()
            latest_amd: Dict[str, int] = {}
            for (po_number, amd), po_id in self._by_key.items():
                if po_number not in latest_amd or amd > latest_amd[po_number]:
                    latest_amd[po_number] = amd
                    self._latest[po_number] = po_id
        log.debug(
            "po prefetch: keys=%d distinct_numbers=%d",
            len(self._by_key),
            len(self._latest),
        )

    def resolve(self, po_number: Optional[str], amd_no: Optional[int] = None) -> Optional[int]:
        if not po_number:
            return None
        po_number = po_number.strip()
        if not po_number:
            return None
        if amd_no is not None:
            key = (po_number, int(amd_no))
            if key in self._by_key:
                return self._by_key[key]
            with self.conn.cursor() as cur:
                cur.execute(
                    "SELECT po_id FROM purchase_orders WHERE po_number = %s AND amd_no = %s",
                    (po_number, int(amd_no)),
                )
                row = cur.fetchone()
                if row:
                    self._by_key[key] = row[0]
                    return row[0]
            return None
        # latest amendment
        if po_number in self._latest:
            return self._latest[po_number]
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT po_id FROM purchase_orders WHERE po_number = %s "
                "ORDER BY amd_no DESC LIMIT 1",
                (po_number,),
            )
            row = cur.fetchone()
            if row:
                self._latest[po_number] = row[0]
                return row[0]
        return None

    def record(self, po_number: str, amd_no: int, po_id: int) -> None:
        """Notify the resolver of a freshly-upserted PO row."""
        key = (po_number, int(amd_no))
        self._by_key[key] = po_id
        cur_latest = self._latest.get(po_number)
        if cur_latest is None:
            self._latest[po_number] = po_id
        else:
            # We don't track amd_no for cur_latest separately here — refresh
            # from the dict we just updated.
            latest_amd = max(
                amd for (pn, amd) in self._by_key.keys() if pn == po_number
            )
            for (pn, amd), pid in self._by_key.items():
                if pn == po_number and amd == latest_amd:
                    self._latest[po_number] = pid
                    break
