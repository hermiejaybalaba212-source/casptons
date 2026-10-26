"""Minimal Supabase Storage client (list + download) using urllib only."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Dict, List, Optional

from . import config as _config


class StorageError(RuntimeError):
    pass


def _headers(key: str, content_json: bool = False) -> Dict[str, str]:
    headers = {"apikey": key, "Authorization": "Bearer " + key}
    if content_json:
        headers["Content-Type"] = "application/json"
    return headers


def list_all(bucket: str, prefix: str = "") -> List[Dict]:
    """Recursively list every object under ``prefix`` (folders included)."""
    url, key = _config.supabase_config()
    if not url or not key:
        raise StorageError("Supabase URL / service role key missing from .env.local")

    body = json.dumps({"prefix": prefix, "limit": 1000}).encode()
    request = urllib.request.Request(
        f"{url}/storage/v1/object/list/{bucket}",
        data=body,
        headers=_headers(key, True),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            entries = json.loads(response.read().decode() or "[]")
    except urllib.error.HTTPError as exc:
        raise StorageError(f"list failed for '{prefix}': HTTP {exc.code}") from exc

    files: List[Dict] = []
    for entry in entries:
        name = entry.get("name") or ""
        path = f"{prefix}{name}"
        if entry.get("metadata") is None:
            files.extend(list_all(bucket, path + "/"))
        else:
            files.append(
                {
                    "path": path,
                    "name": name,
                    "size": int((entry.get("metadata") or {}).get("size") or 0),
                    "updated_at": entry.get("updated_at"),
                }
            )
    return files


def download(bucket: str, path: str) -> bytes:
    """Download a private object through a short-lived signed URL."""
    url, key = _config.supabase_config()
    if not url or not key:
        raise StorageError("Supabase URL / service role key missing from .env.local")

    request = urllib.request.Request(
        f"{url}/storage/v1/object/sign/{bucket}/{path}",
        data=json.dumps({"expiresIn": 600}).encode(),
        headers=_headers(key, True),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            signed = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        raise StorageError(f"signed URL failed for '{path}': HTTP {exc.code}") from exc

    signed_path = signed.get("signedURL") or signed.get("signedUrl")
    if not signed_path:
        raise StorageError(f"no signed URL returned for '{path}'")

    try:
        with urllib.request.urlopen(
            urllib.request.Request(url + "/storage/v1" + signed_path, headers=_headers(key)),
            timeout=120,
        ) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        raise StorageError(f"download failed for '{path}': HTTP {exc.code}") from exc


def owner_hint(path: Optional[str]) -> Optional[str]:
    """Storage folders are named after the owning student id."""
    if not path:
        return None
    parts = str(path).split("/")
    return parts[0] if parts and parts[0].isdigit() else None
