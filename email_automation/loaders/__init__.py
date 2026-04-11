"""Postgres loaders for the six document types.

Each loader module exposes a `load(conn, parsed_rows, *, run_id) -> LoadResult`
function. The loader runs in the transaction of the connection it is given
so the caller controls commit/rollback. Loaders never reach across files —
multi-file orchestration lives in run.py / phase2_smoke_test.py.
"""
