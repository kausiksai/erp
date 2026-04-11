"""Email ingestion layer for the automation pipeline.

Exposes:
    classify(subject, filename)     -> ClassificationResult
    make_source(kind)               -> MailSource
    FileLock                        -> per-run lock file
"""

from .classifier import ClassificationResult, classify  # noqa: F401
from .lockfile import FileLock, LockError  # noqa: F401
from .source import (  # noqa: F401
    FetchedAttachment,
    FetchedMessage,
    LocalMailSource,
    MailSource,
    ZohoMailSource,
    make_source,
)
