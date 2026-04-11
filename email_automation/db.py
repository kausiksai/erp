"""Thread-safe Postgres connection pool for the email automation pipeline.

Exposes:
    get_pool()      lazy-initialise and return the singleton pool
    close_pool()    tear down the pool (used on process exit / tests)
    get_conn()      context manager yielding a pooled connection with
                    commit-on-success / rollback-on-exception semantics
    get_cursor()    convenience wrapper that also yields a cursor
    ping()          connectivity smoke test, safe to call from run.py

Design notes
    * ThreadedConnectionPool is used so that future concurrent phases (e.g.
      parallel file uploads) do not need to re-architect the DB layer.
    * `sslmode=require` by default — production RDS mandates TLS.
    * Every exception path releases the connection back to the pool to
      prevent leaks on long-running processes.
    * RealDictCursor is the default so downstream code can address columns
      by name; callers that need tuples can pass `dict_rows=False`.
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


# ----------------------------------------------------------------------------
# Pool lifecycle
# ----------------------------------------------------------------------------
def _build_pool(cfg: DBConfig) -> pgpool.ThreadedConnectionPool:
    try:
        return pgpool.ThreadedConnectionPool(
            minconn=cfg.min_conn,
            maxconn=cfg.max_conn,
            dsn=cfg.dsn(),
        )
    except psycopg2.Error as exc:
        raise DatabaseError(
            f"Failed to initialise Postgres pool "
            f"({cfg.redacted_repr()}): {exc}"
        ) from exc


def get_pool() -> pgpool.ThreadedConnectionPool:
    """Return the lazily-initialised singleton pool."""
    global _pool
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                _pool = _build_pool(CONFIG.db)
                log.info("pg pool ready %s", CONFIG.db.redacted_repr())
    return _pool


def close_pool() -> None:
    """Close all pooled connections. Safe to call multiple times."""
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


# ----------------------------------------------------------------------------
# Context managers
# ----------------------------------------------------------------------------
@contextmanager
def get_conn(
    *,
    readonly: bool = False,
    autocommit: bool = False,
) -> Iterator[PGConnection]:
    """Yield a pooled connection.

    * On clean exit: COMMIT (unless autocommit is True).
    * On exception: ROLLBACK and re-raise.
    * Always returns the connection to the pool.
    """
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
                # set_session requires autocommit=False
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
        # Reset session flags before returning to pool so the next borrower
        # starts from a clean state.
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
    *,
    readonly: bool = False,
    autocommit: bool = False,
    dict_rows: bool = True,
) -> Iterator[Any]:
    """Convenience wrapper that yields a cursor with the same semantics as get_conn."""
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


# ----------------------------------------------------------------------------
# Health check
# ----------------------------------------------------------------------------
def ping() -> bool:
    """Return True if the DB is reachable and responds to a trivial query."""
    try:
        with get_cursor(readonly=True) as cur:
            cur.execute(
                "SELECT 1 AS ok, current_database() AS db, "
                "current_user AS usr, version() AS ver"
            )
            row = cur.fetchone()
            if not row or row["ok"] != 1:
                log.error("pg ping returned unexpected row: %r", row)
                return False
            log.info(
                "pg ping ok db=%s user=%s server=%s",
                row["db"],
                row["usr"],
                str(row["ver"]).split(" on ")[0],
            )
            return True
    except (DatabaseError, psycopg2.Error) as exc:
        log.error("pg ping failed: %s", exc)
        return False
