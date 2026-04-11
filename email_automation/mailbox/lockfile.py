"""Simple PID-based file lock to prevent overlapping runs.

Semantics
    * `acquire()` creates a new lock file with the current PID as contents.
    * If a lock file already exists, we check whether the recorded PID is
      still alive. Live PID -> LockError. Dead PID -> the lock is stale and
      we reclaim it.
    * `release()` removes the lock file if this process owns it.
    * Use as a context manager: `with FileLock(path): ...`.

Cross-platform PID check — uses Win32 OpenProcess on Windows and os.kill(0)
on POSIX.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from types import TracebackType
from typing import Optional, Type

log = logging.getLogger(__name__)


class LockError(RuntimeError):
    """Raised when another run already holds the lock."""


class FileLock:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._acquired = False

    def acquire(self) -> None:
        if self.path.exists():
            pid = self._read_pid()
            if pid and self._pid_alive(pid):
                raise LockError(
                    f"another automation run is in progress (pid={pid}, lock={self.path})"
                )
            log.warning("stale lock file found (pid=%s), removing", pid)
            try:
                self.path.unlink()
            except OSError as exc:
                log.error("failed to remove stale lock: %s", exc)
                raise LockError(f"cannot remove stale lock {self.path}: {exc}") from exc

        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("x", encoding="utf-8") as fh:
                fh.write(str(os.getpid()))
        except FileExistsError as exc:
            raise LockError(f"lock appeared while acquiring: {self.path}") from exc
        except OSError as exc:
            raise LockError(f"cannot create lock {self.path}: {exc}") from exc

        self._acquired = True
        log.info("acquired lock %s (pid=%d)", self.path, os.getpid())

    def release(self) -> None:
        if not self._acquired:
            return
        if self.path.exists():
            try:
                self.path.unlink()
                log.info("released lock %s", self.path)
            except OSError as exc:
                log.warning("failed to remove lock: %s", exc)
        self._acquired = False

    def __enter__(self) -> "FileLock":
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: Optional[Type[BaseException]],
        exc_val: Optional[BaseException],
        exc_tb: Optional[TracebackType],
    ) -> None:
        self.release()

    # ------------------------------------------------------------------
    def _read_pid(self) -> Optional[int]:
        try:
            text = self.path.read_text(encoding="utf-8").strip()
            return int(text) if text else None
        except (OSError, ValueError):
            return None

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        if pid <= 0:
            return False
        if os.name == "nt":
            try:
                import ctypes

                STILL_ACTIVE = 259
                PROCESS_QUERY_INFORMATION = 0x0400
                handle = ctypes.windll.kernel32.OpenProcess(
                    PROCESS_QUERY_INFORMATION, 0, pid
                )
                if not handle:
                    return False
                try:
                    exit_code = ctypes.c_ulong(0)
                    ctypes.windll.kernel32.GetExitCodeProcess(
                        handle, ctypes.byref(exit_code)
                    )
                    return exit_code.value == STILL_ACTIVE
                finally:
                    ctypes.windll.kernel32.CloseHandle(handle)
            except Exception:
                return False
        else:
            try:
                os.kill(pid, 0)
                return True
            except (OSError, ProcessLookupError):
                return False
