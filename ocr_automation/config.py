"""Typed configuration loader for the OCR automation pipeline.

Same shape and rigour as email_automation/config.py — fail fast at import
time, never log secrets, expose immutable dataclasses.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

PACKAGE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PACKAGE_DIR.parent
ENV_PATH = PACKAGE_DIR / ".env"

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


@dataclass(frozen=True)
class DBConfig:
    host: str
    port: int
    database: str
    user: str
    password: str = field(repr=False)
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
                "application_name=ocr_automation",
            ]
        )

    def redacted_repr(self) -> str:
        return (
            f"DBConfig(host={self.host!r}, port={self.port}, db={self.database!r}, "
            f"user={self.user!r}, sslmode={self.sslmode!r}, "
            f"pool={self.min_conn}-{self.max_conn})"
        )


@dataclass(frozen=True)
class DriveConfig:
    folder_id: str
    service_account_json_path: Path


@dataclass(frozen=True)
class BackendConfig:
    base_url: str
    auth_token: str = field(repr=False)
    request_timeout: int


@dataclass(frozen=True)
class RuntimeConfig:
    timezone: str
    log_level: str
    concurrency: int
    max_retries: int
    max_extraction_pages: int  # how many leading PDF pages to send to OCR


@dataclass(frozen=True)
class PathsConfig:
    root: Path
    logs: Path
    lock_file: Path


@dataclass(frozen=True)
class AppConfig:
    db: DBConfig
    drive: DriveConfig
    backend: BackendConfig
    runtime: RuntimeConfig
    paths: PathsConfig


def _resolve_credentials_path(raw: str) -> Path:
    p = Path(raw).expanduser()
    if not p.is_absolute():
        # Resolve relative to the repo root (parent of this package),
        # so paths like "ocr_automation/credentials/service_account.json"
        # work from any cwd.
        p = (PROJECT_ROOT / p).resolve()
    return p


def _load_paths() -> PathsConfig:
    root = Path(_optional("OA_ROOT", str(PACKAGE_DIR))).resolve()
    logs = root / "logs"
    lock_file = root / ".lock"
    try:
        logs.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ConfigError(f"Cannot create logs directory {logs}: {exc}") from exc
    return PathsConfig(root=root, logs=logs, lock_file=lock_file)


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

        sa_path = _resolve_credentials_path(
            _optional(
                "GOOGLE_SERVICE_ACCOUNT_JSON",
                "ocr_automation/credentials/service_account.json",
            )
        )
        drive = DriveConfig(
            folder_id=_require("DRIVE_FOLDER_ID"),
            service_account_json_path=sa_path,
        )

        backend = BackendConfig(
            base_url=_optional("BACKEND_BASE_URL", "http://localhost:4000/api").rstrip("/"),
            auth_token=_optional("BACKEND_AUTH_TOKEN", ""),
            request_timeout=_int("OCR_REQUEST_TIMEOUT_SECONDS", 180),
        )

        concurrency = _int("OCR_CONCURRENCY", 3)
        if concurrency < 1 or concurrency > 10:
            raise ConfigError(
                f"OCR_CONCURRENCY must be in [1, 10], got {concurrency}"
            )
        max_retries = _int("OCR_MAX_RETRIES", 2)
        if max_retries < 0 or max_retries > 5:
            raise ConfigError(
                f"OCR_MAX_RETRIES must be in [0, 5], got {max_retries}"
            )
        log_level = _optional("LOG_LEVEL", "INFO").upper()
        if log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ConfigError(f"LOG_LEVEL must be a standard logging level, got {log_level!r}")
        max_pages = _int("OCR_MAX_PAGES_FOR_EXTRACTION", 2)
        if max_pages < 1 or max_pages > 50:
            raise ConfigError(
                f"OCR_MAX_PAGES_FOR_EXTRACTION must be in [1, 50], got {max_pages}"
            )
        runtime = RuntimeConfig(
            timezone=_optional("TIMEZONE", "Asia/Kolkata"),
            log_level=log_level,
            concurrency=concurrency,
            max_retries=max_retries,
            max_extraction_pages=max_pages,
        )

        paths = _load_paths()

        return AppConfig(db=db, drive=drive, backend=backend, runtime=runtime, paths=paths)
    except ConfigError as exc:
        print(f"[ocr_automation.config] FATAL: {exc}", file=sys.stderr)
        raise


CONFIG: AppConfig = load_config()
