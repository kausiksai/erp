"""Thread-safe Postgres connection pool for the OCR automation pipeline.

Mirrors email_automation/db.py — same semantics so anyone who already knows
that module can debug this one without re-reading. Concurrency is enabled
by default since the OCR pipeline runs files in parallel.
"""

from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Optional

import psycopg2
from psycopg2 import pool as pgpool
from psycopg2.extensions import connection as PGConnection
from psycopg2.extras import RealDictCursor

from .config import CONFIG, DBConfig

log = logging.getLogger(__name__)

_pool_lock = threading.Lock()
_pool: Optional[pgpool.ThreadedConnectionPool] = None


class DatabaseError(RuntimeError):
    """Raised on connection pool or transaction errors."""


def _build_pool(cfg: DBConfig) -> pgpool.ThreadedConnectionPool:
    try:
        return pgpool.ThreadedConnectionPool(
            minconn=cfg.min_conn,
            maxconn=cfg.max_conn,
            dsn=cfg.dsn(),
        )
    except psycopg2.Error as exc:
        raise DatabaseError(
            f"Failed to initialise Postgres pool ({cfg.redacted_repr()}): {exc}"
        ) from exc


def get_pool() -> pgpool.ThreadedConnectionPool:
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = _build_pool(CONFIG.db)
                log.info("pg pool ready %s", CONFIG.db.redacted_repr())
    return _pool


def close_pool() -> None:
    global _pool
    with _pool_lock:
        if _pool is None:
            return
        try:
            _pool.closeall()
            log.info("pg pool closed")
        except psycopg2.Error as exc:
            log.warning("error closing pg pool: %s", exc)
        finally:
            _pool = None


@contextmanager
def get_conn(*, readonly: bool = False, autocommit: bool = False) -> Iterator[PGConnection]:
    pool = get_pool()
    try:
        conn: PGConnection = pool.getconn()
    except psycopg2.Error as exc:
        raise DatabaseError(f"Failed to acquire DB connection: {exc}") from exc

    used_readonly_session = False
    try:
        if autocommit:
            conn.autocommit = True
        else:
            conn.autocommit = False
            if readonly:
                conn.set_session(readonly=True)
                used_readonly_session = True

        yield conn

        if not autocommit:
            conn.commit()
    except Exception:
        if not autocommit:
            try:
                conn.rollback()
            except psycopg2.Error as rollback_exc:
                log.error("rollback failed: %s", rollback_exc)
        raise
    finally:
        try:
            if used_readonly_session:
                conn.set_session(readonly=False)
            conn.autocommit = False
        except psycopg2.Error as exc:
            log.warning("session reset failed (connection will be discarded): %s", exc)
            try:
                pool.putconn(conn, close=True)
            except psycopg2.Error:
                pass
            return
        try:
            pool.putconn(conn)
        except psycopg2.Error as exc:
            log.error("pool putconn failed: %s", exc)


@contextmanager
def get_cursor(
    *, readonly: bool = False, autocommit: bool = False, dict_rows: bool = True
) -> Iterator[Any]:
    factory = RealDictCursor if dict_rows else None
    with get_conn(readonly=readonly, autocommit=autocommit) as conn:
        cur = conn.cursor(cursor_factory=factory)
        try:
            yield cur
        finally:
            try:
                cur.close()
            except psycopg2.Error as exc:
                log.warning("cursor close failed: %s", exc)


def ping() -> bool:
    try:
        with get_cursor(readonly=True) as cur:
            cur.execute("SELECT 1 AS ok")
            row = cur.fetchone()
            return bool(row and row["ok"] == 1)
    except (DatabaseError, psycopg2.Error) as exc:
        log.error("pg ping failed: %s", exc)
        return False
