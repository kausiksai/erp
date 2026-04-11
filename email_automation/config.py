"""Typed configuration loader for the email automation pipeline.

Responsibilities
    * Load email_automation/.env with python-dotenv.
    * Validate required environment variables and coerce types.
    * Expose immutable dataclasses so that code downstream cannot mutate
      configuration at runtime.
    * Fail fast at import time when a required variable is missing, so that
      misconfiguration is caught before any side effects occur.

The module must never print secret values. The __repr__ of DBConfig redacts
the password.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_DIR.parent
ENV_PATH = PACKAGE_DIR / ".env"

# override=False so that a value already set in the OS environment (e.g. when
# running under systemd or a container) takes precedence over the .env file.
load_dotenv(dotenv_path=ENV_PATH, override=False)


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or invalid."""


def _require(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        raise ConfigError(
            f"Required environment variable {name!r} is not set. "
            f"Check {ENV_PATH} or the process environment."
        )
    return value.strip()


def _optional(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return value.strip() if value is not None else default


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError as exc:
        raise ConfigError(
            f"Environment variable {name!r} must be an integer, got {raw!r}"
        ) from exc


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "y"}


@dataclass(frozen=True)
class DBConfig:
    host: str
    port: int
    database: str
    user: str
    password: str = field(repr=False)  # redact from repr / logs
    sslmode: str
    min_conn: int
    max_conn: int
    connect_timeout: int

    def dsn(self) -> str:
        return " ".join(
            [
                f"host={self.host}",
                f"port={self.port}",
                f"dbname={self.database}",
                f"user={self.user}",
                f"password={self.password}",
                f"sslmode={self.sslmode}",
                f"connect_timeout={self.connect_timeout}",
                "application_name=email_automation",
            ]
        )

    def redacted_repr(self) -> str:
        return (
            f"DBConfig(host={self.host!r}, port={self.port}, db={self.database!r}, "
            f"user={self.user!r}, sslmode={self.sslmode!r}, "
            f"pool={self.min_conn}-{self.max_conn})"
        )


@dataclass(frozen=True)
class IMAPConfig:
    host: str
    port: int
    user: str
    password: str = field(repr=False)
    mailbox: str
    allowed_sender: str
    use_ssl: bool


@dataclass(frozen=True)
class PathsConfig:
    root: Path
    downloaded: Path
    failed: Path
    logs: Path
    lock_file: Path


@dataclass(frozen=True)
class AlertConfig:
    enabled: bool
    recipient: str
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str = field(repr=False)
    smtp_from: str


@dataclass(frozen=True)
class RuntimeConfig:
    timezone: str
    window_start_hour: int
    window_end_hour: int
    log_level: str


@dataclass(frozen=True)
class AppConfig:
    db: DBConfig
    imap: IMAPConfig
    paths: PathsConfig
    alert: AlertConfig
    runtime: RuntimeConfig


def _load_paths() -> PathsConfig:
    root = Path(_optional("EA_ROOT", str(PACKAGE_DIR))).resolve()
    downloaded = root / "downloaded"
    failed = root / "failed"
    logs = root / "logs"
    lock_file = root / ".lock"
    for p in (downloaded, failed, logs):
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ConfigError(f"Cannot create runtime directory {p}: {exc}") from exc
    return PathsConfig(
        root=root,
        downloaded=downloaded,
        failed=failed,
        logs=logs,
        lock_file=lock_file,
    )


def _load_runtime() -> RuntimeConfig:
    start = _int("WINDOW_START_HOUR", 16)
    end = _int("WINDOW_END_HOUR", 18)
    if not (0 <= start <= 23) or not (0 <= end <= 23):
        raise ConfigError(
            f"WINDOW_*_HOUR must be in [0, 23] (got start={start} end={end})"
        )
    if end <= start:
        raise ConfigError(
            f"WINDOW_END_HOUR ({end}) must be greater than WINDOW_START_HOUR ({start})"
        )
    level = _optional("LOG_LEVEL", "INFO").upper()
    if level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise ConfigError(f"LOG_LEVEL must be a standard logging level, got {level!r}")
    return RuntimeConfig(
        timezone=_optional("TIMEZONE", "Asia/Kolkata"),
        window_start_hour=start,
        window_end_hour=end,
        log_level=level,
    )


def load_config() -> AppConfig:
    try:
        db = DBConfig(
            host=_require("PGHOST"),
            port=_int("PGPORT", 5432),
            database=_require("PGDATABASE"),
            user=_require("PGUSER"),
            password=_require("PGPASSWORD"),
            sslmode=_optional("PGSSLMODE", "require"),
            min_conn=_int("PG_MIN_CONN", 1),
            max_conn=_int("PG_MAX_CONN", 4),
            connect_timeout=_int("PG_CONNECT_TIMEOUT", 10),
        )
        if db.min_conn < 1 or db.max_conn < db.min_conn:
            raise ConfigError(
                f"PG pool bounds invalid: min={db.min_conn} max={db.max_conn}"
            )

        imap = IMAPConfig(
            host=_optional("IMAP_HOST", "imap.zoho.in"),
            port=_int("IMAP_PORT", 993),
            user=_optional("IMAP_USER"),
            password=_optional("IMAP_PASSWORD"),
            mailbox=_optional("IMAP_MAILBOX", "INBOX"),
            allowed_sender=_optional(
                "IMAP_ALLOWED_SENDER", "srimukha.purchase@srimukhagroup.co.in"
            ),
            use_ssl=_bool("IMAP_SSL", True),
        )

        alert = AlertConfig(
            enabled=_bool("ALERT_ENABLED", False),
            recipient=_optional("ALERT_RECIPIENT", "nandavsk@outlook.com"),
            smtp_host=_optional("SMTP_HOST", ""),
            smtp_port=_int("SMTP_PORT", 587),
            smtp_user=_optional("SMTP_USER", ""),
            smtp_password=_optional("SMTP_PASSWORD", ""),
            smtp_from=_optional("SMTP_FROM", ""),
        )

        paths = _load_paths()
        runtime = _load_runtime()

        return AppConfig(db=db, imap=imap, paths=paths, alert=alert, runtime=runtime)
    except ConfigError as exc:
        # Print to stderr so the error is visible when the package is used as
        # a CLI (e.g. `python -m email_automation.run`) and re-raise so
        # callers can distinguish config failures from runtime failures.
        print(f"[config] FATAL: {exc}", file=sys.stderr)
        raise


# Import-time load so that any misconfiguration is caught before any DB or
# IMAP connection is attempted. Downstream modules import CONFIG directly.
CONFIG: AppConfig = load_config()
