"""Google Drive client — service-account auth, list folder, download bytes.

Only reads (Viewer scope on the shared folder is sufficient). Never modifies
anything in Drive.
"""

from __future__ import annotations

import io
import logging
import os
import socket
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterator, List, Optional

import httplib2
from google.oauth2 import service_account
from google_auth_httplib2 import AuthorizedHttp
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload


# Some networks (corporate, AWS instances, restricted dev machines) advertise
# AAAA records but silently black-hole IPv6 traffic. Python's stock
# `socket.getaddrinfo` then offers IPv6 first, and httplib2's connect blocks
# until its timeout fires before falling through to IPv4. Set
# OCR_FORCE_IPV4=1 (or leave unset; it's the default for this module) to
# pre-filter resolution to IPv4 only and avoid the stall entirely.
def _maybe_force_ipv4() -> None:
    if os.environ.get("OCR_FORCE_IPV4", "1") not in {"1", "true", "yes"}:
        return
    original = socket.getaddrinfo

    def _ipv4_only(host, port, family=0, type_=0, proto=0, flags=0):
        # Only constrain when caller didn't already specify a family.
        if family == 0:
            family = socket.AF_INET
        return original(host, port, family, type_, proto, flags)

    socket.getaddrinfo = _ipv4_only  # type: ignore[assignment]


_maybe_force_ipv4()

from .config import CONFIG

log = logging.getLogger(__name__)

# Read-only is enough — we only list and download.
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

# MIME types we care about. Drive tags PDFs as application/pdf and images
# with their normal types. Anything else (Excel, Word, folders, Google Docs)
# is ignored — those go through the email_automation pipeline.
INVOICE_MIME_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
}


class DriveAuthError(RuntimeError):
    pass


class DriveListError(RuntimeError):
    pass


class DriveDownloadError(RuntimeError):
    pass


@dataclass(frozen=True)
class DriveFile:
    file_id: str
    name: str
    mime_type: str
    modified_time: Optional[datetime]
    size_bytes: Optional[int]


def _build_service():
    key_path: Path = CONFIG.drive.service_account_json_path
    if not key_path.is_file():
        raise DriveAuthError(
            f"Service account key file not found at {key_path}. "
            "Download a JSON key from Google Cloud Console and place it there."
        )
    try:
        creds = service_account.Credentials.from_service_account_file(
            str(key_path), scopes=SCOPES
        )
    except Exception as exc:
        raise DriveAuthError(f"Failed to load service account from {key_path}: {exc}") from exc
    # Wrap with an httplib2 client that has an explicit 30s timeout. Without
    # this httplib2 has no timeout at all, so on networks where IPv6 routes
    # are broken the OAuth token refresh hangs indefinitely instead of
    # falling back to IPv4. The timeout lets socket.create_connection fail
    # fast on IPv6 and retry IPv4.
    http = AuthorizedHttp(creds, http=httplib2.Http(timeout=30))
    # cache_discovery=False avoids the deprecated file_cache warning when
    # running outside an interactive Python install.
    return build("drive", "v3", http=http, cache_discovery=False)


FOLDER_MIME = "application/vnd.google-apps.folder"
MAX_RECURSION_DEPTH = 5


def _list_children(service, folder_id: str) -> List[dict]:
    """One folder's direct children — folders included — paginated."""
    children: List[dict] = []
    page_token: Optional[str] = None
    while True:
        resp = (
            service.files()
            .list(
                q=f"'{folder_id}' in parents and trashed = false",
                fields=(
                    "nextPageToken, "
                    "files(id, name, mimeType, modifiedTime, size)"
                ),
                pageSize=200,
                pageToken=page_token,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        children.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return children


def list_invoice_files(folder_id: Optional[str] = None) -> List[DriveFile]:
    """List PDFs and images in the configured folder *and any subfolders*
    (recursively, up to MAX_RECURSION_DEPTH levels). Suppliers / finance ops
    typically organise invoices into dated subfolders (e.g. `2026-04-28/`),
    so a flat listing would miss them. Skips folders themselves, Google Docs,
    and trashed items.
    """
    root = folder_id or CONFIG.drive.folder_id
    service = _build_service()

    results: List[DriveFile] = []
    folders_seen = 0
    # BFS so the log message reflects every folder we visited.
    queue: List[tuple] = [(root, 0)]
    visited: set = set()
    try:
        while queue:
            current, depth = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)
            folders_seen += 1
            for f in _list_children(service, current):
                mt = f.get("mimeType")
                if mt == FOLDER_MIME:
                    if depth + 1 <= MAX_RECURSION_DEPTH:
                        queue.append((f["id"], depth + 1))
                    else:
                        log.warning(
                            "skipping folder %s (depth>%d)", f.get("name"), MAX_RECURSION_DEPTH
                        )
                    continue
                if mt not in INVOICE_MIME_TYPES:
                    continue  # ignore Excel, Google Docs, etc.
                modified = None
                raw_modified = f.get("modifiedTime")
                if raw_modified:
                    try:
                        modified = datetime.fromisoformat(raw_modified.replace("Z", "+00:00"))
                    except ValueError:
                        modified = None
                size = f.get("size")
                size_bytes = int(size) if size is not None else None
                results.append(
                    DriveFile(
                        file_id=f["id"],
                        name=f["name"],
                        mime_type=mt,
                        modified_time=modified,
                        size_bytes=size_bytes,
                    )
                )
    except HttpError as exc:
        raise DriveListError(
            f"Drive list failed under folder={root}: {exc}. "
            "Check that the folder is shared with the service account email."
        ) from exc
    log.info(
        "Drive list returned %d invoice file(s) across %d folder(s) under %s",
        len(results), folders_seen, root,
    )
    return results


def download_file(file_id: str) -> bytes:
    """Stream a file's bytes into memory. PDFs are typically <2 MB; cap is the
    backend's 10 MB upload limit, enforced by the caller.
    """
    service = _build_service()
    buf = io.BytesIO()
    try:
        request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
        downloader = MediaIoBaseDownload(buf, request, chunksize=1024 * 1024)
        done = False
        while not done:
            _status, done = downloader.next_chunk()
    except HttpError as exc:
        raise DriveDownloadError(f"Drive download failed for file_id={file_id}: {exc}") from exc
    return buf.getvalue()
