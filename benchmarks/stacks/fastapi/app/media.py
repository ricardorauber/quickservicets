"""Upload helpers: content type detection from magic bytes, file names and local storage."""

import os
import re

MAX_SIZE = 1024 * 1024
ACCEPT = frozenset(["image/png", "image/jpeg"])
MANAGED_FIELDS = frozenset(["id", "createdAt", "updatedAt", "filename", "mimeType", "size", "storage", "url"])

_SIGNATURES: list[tuple[str, bytes, int]] = [
    ("image/png", b"\x89PNG\r\n\x1a\n", 0),
    ("image/jpeg", b"\xff\xd8\xff", 0),
    ("image/gif", b"GIF87a", 0),
    ("image/gif", b"GIF89a", 0),
    ("application/pdf", b"%PDF-", 0),
    ("audio/mpeg", b"ID3", 0),
]
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_DISPOSITION_UNSAFE = re.compile(r'["\\\x00-\x1f]')


def detect(head: bytes) -> str | None:
    """The type a file's first bytes show, or None for content this service does not recognize."""
    for mime, signature, offset in _SIGNATURES:
        if head.startswith(signature, offset):
            return mime
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def essence(content_type: str | None) -> str:
    """A MIME type without parameters, in lower case."""
    return (content_type or "").split(";", 1)[0].strip().lower()


def sanitize_filename(name: str) -> str:
    """The base name, without control characters, cut to 255 characters."""
    base = re.split(r"[\\/]", name)[-1]
    return _CONTROL.sub("", base)[:255]


def extension(filename: str) -> str:
    """The lowercased extension with its dot, or "" (".env" has none)."""
    return os.path.splitext(filename)[1].lower()


def content_disposition(filename: str) -> str:
    return f'inline; filename="{_DISPOSITION_UNSAFE.sub("", filename)}"'


def write_file(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as file:
        file.write(data)


def read_file(path: str) -> bytes | None:
    try:
        with open(path, "rb") as file:
            return file.read()
    except FileNotFoundError:
        return None


def remove_file(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
