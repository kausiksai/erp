"""Logging setup. File handler in logs/, console handler at the configured
level. Imported once from run.py at startup.
"""

from __future__ import annotations

import logging
import logging.handlers
from datetime import datetime

from .config import CONFIG


def setup_logging() -> None:
    level = getattr(logging, CONFIG.runtime.log_level, logging.INFO)
    fmt = "%(asctime)s %(levelname)-7s %(name)s | %(message)s"
    formatter = logging.Formatter(fmt, datefmt="%Y-%m-%d %H:%M:%S")

    root = logging.getLogger()
    root.setLevel(level)
    # Clear any pre-existing handlers (test harnesses, IDE imports, etc.)
    for h in list(root.handlers):
        root.removeHandler(h)

    # Console
    sh = logging.StreamHandler()
    sh.setFormatter(formatter)
    sh.setLevel(level)
    root.addHandler(sh)

    # Daily rotating file
    log_path = CONFIG.paths.logs / f"ocr_automation_{datetime.now():%Y%m%d}.log"
    fh = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=10 * 1024 * 1024, backupCount=14, encoding="utf-8"
    )
    fh.setFormatter(formatter)
    fh.setLevel(level)
    root.addHandler(fh)

    # Quiet down noisy libs
    logging.getLogger("googleapiclient.discovery_cache").setLevel(logging.ERROR)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
