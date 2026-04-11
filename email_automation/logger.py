"""Logging setup for the email automation package.

One call to `setup_logging()` configures the root logger with:
    * A console handler (stdout) at the configured level.
    * A rotating file handler under email_automation/logs/email_automation.log
      (10 MB per file, 10 backups).
    * Reduced verbosity on noisy third-party libraries.

The function is idempotent — subsequent calls return the cached logger
without re-adding handlers, so it is safe to call from every entry point.
"""

from __future__ import annotations

import logging
import logging.handlers
import sys
from typing import Optional

from .config import CONFIG

_LOG_FORMAT = (
    "%(asctime)s %(levelname)-5s [%(name)s:%(funcName)s:%(lineno)d] %(message)s"
)
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
_MAX_BYTES = 10 * 1024 * 1024   # 10 MB
_BACKUP_COUNT = 10

_configured = False


def setup_logging(name: str = "email_automation") -> logging.Logger:
    """Configure root logging once; return a named logger.

    Safe to call from multiple entry points — subsequent calls are no-ops
    and return a cached logger.
    """
    global _configured
    if _configured:
        return logging.getLogger(name)

    level_name = CONFIG.runtime.log_level
    level = getattr(logging, level_name, logging.INFO)
    if not isinstance(level, int):
        level = logging.INFO

    root = logging.getLogger()
    root.setLevel(level)
    # Remove any handlers inherited from parent processes / test runners so
    # our config is authoritative.
    for handler in list(root.handlers):
        root.removeHandler(handler)

    formatter = logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT)

    # --- Console handler --------------------------------------------------
    console = logging.StreamHandler(stream=sys.stdout)
    console.setLevel(level)
    console.setFormatter(formatter)
    root.addHandler(console)

    # --- Rotating file handler --------------------------------------------
    log_file = CONFIG.paths.logs / "email_automation.log"
    try:
        file_handler = logging.handlers.RotatingFileHandler(
            str(log_file),
            maxBytes=_MAX_BYTES,
            backupCount=_BACKUP_COUNT,
            encoding="utf-8",
        )
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    except OSError as exc:
        # If the log file cannot be created (disk full, permission denied)
        # we still want the console handler to work. Log to stderr and carry
        # on; do not crash the process because of logging alone.
        print(
            f"[logger] warning: file logging disabled ({log_file}): {exc}",
            file=sys.stderr,
        )

    # --- Quiet noisy libraries --------------------------------------------
    logging.getLogger("psycopg2").setLevel(logging.WARNING)
    logging.getLogger("imaplib").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    _configured = True
    logger = logging.getLogger(name)
    logger.debug(
        "logging configured level=%s file=%s",
        level_name,
        log_file,
    )
    return logger


def get_logger(name: Optional[str] = None) -> logging.Logger:
    """Shortcut for modules that do not need to trigger setup."""
    return logging.getLogger(name or "email_automation")
