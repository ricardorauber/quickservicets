"""Shared helpers: JSON responses, the error envelope, ids and timestamps."""

import os
import time
from datetime import UTC, datetime
from typing import Any

import orjson
from starlette.responses import Response

CODES = {
    400: "VALIDATION_ERROR",
    404: "NOT_FOUND",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    500: "INTERNAL_ERROR",
}


class JSONResponse(Response):
    """A JSON response rendered with orjson (FastAPI's own JSONResponse goes through the stdlib json module)."""

    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content)


Detail = dict[str, str]


class ApiError(Exception):
    """An error answered with the contract's envelope: {"error": {"code", "message", "details"?}}."""

    def __init__(self, status: int, message: str, details: list[Detail] | None = None):
        self.status = status
        self.message = message
        self.details = details

    def response(self) -> JSONResponse:
        error: dict[str, Any] = {"code": CODES.get(self.status, "ERROR"), "message": self.message}
        if self.details is not None:
            error["details"] = self.details
        return JSONResponse({"error": error}, status_code=self.status)


def invalid_body(field: str, message: str) -> ApiError:
    return ApiError(400, "Invalid body", [{"field": field, "message": message}])


def uuid7() -> str:
    """A UUID version 7 (RFC 9562) in canonical lowercase form: 48-bit Unix milliseconds, then random bits."""
    raw = bytearray((time.time_ns() // 1_000_000).to_bytes(6, "big") + os.urandom(10))
    raw[6] = 0x70 | (raw[6] & 0x0F)
    raw[8] = 0x80 | (raw[8] & 0x3F)
    h = raw.hex()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def now() -> datetime:
    """The current time, truncated to milliseconds so that what is stored is what is returned."""
    current = datetime.now(UTC)
    return current.replace(microsecond=current.microsecond // 1000 * 1000)


def iso(value: datetime) -> str:
    """UTC with exactly three fractional digits, like JavaScript's Date.prototype.toISOString."""
    # asyncpg returns timestamptz values as aware datetimes in UTC, so isoformat ends with "+00:00".
    return value.isoformat(timespec="milliseconds")[:-6] + "Z"


def number(value: float | None) -> int | float | None:
    """double precision columns holding integral values are serialized as JSON integers."""
    if value is None:
        return None
    return int(value) if value.is_integer() else value
