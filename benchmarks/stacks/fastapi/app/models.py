"""Request bodies of the user routes, validated with Pydantic and reported with the contract's messages."""

from typing import Annotated, Any, Literal

import orjson
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, PlainValidator, ValidationError
from pydantic_core import PydanticCustomError

from .common import ApiError, Detail

EMAIL_PATTERN = r"^[^\s@]+@[^\s@]+\.[^\s@]+$"
READ_ONLY = frozenset(["id", "createdAt", "updatedAt"])


def _name(value: str) -> str:
    # The contract counts UTF-16 code units (JavaScript's length): characters outside the BMP count twice.
    length = len(value) if value.isascii() else len(value.encode("utf-16-le")) // 2
    if length < 1:
        raise PydanticCustomError("name_too_short", "Must be at least 1 characters")
    if length > 100:
        raise PydanticCustomError("name_too_long", "Must be at most 100 characters")
    return value


def _age(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PydanticCustomError("age_type", "Must be a number")
    if isinstance(value, float):
        if not value.is_integer():
            raise PydanticCustomError("age_integer", "Must be an integer")
        value = int(value)
    if value < 0:
        raise PydanticCustomError("age_min", "Must be at least 0")
    if value > 150:
        raise PydanticCustomError("age_max", "Must be at most 150")
    return value


Email = Annotated[str, Field(pattern=EMAIL_PATTERN)]
Name = Annotated[str, AfterValidator(_name)]
Role = Literal["member", "admin"]
Age = Annotated[int | None, PlainValidator(_age)]


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    email: Email
    name: Name
    role: Role = "member"
    age: Age = None


class UserPatch(BaseModel):
    """Every field is optional; defaults are not validated, so an explicit null still fails on email, name and role."""

    model_config = ConfigDict(extra="forbid", strict=True)

    email: Email = None  # type: ignore[assignment]
    name: Name = None  # type: ignore[assignment]
    role: Role = None  # type: ignore[assignment]
    age: Age = None


_MESSAGES = {
    "missing": "Is required",
    "string_type": "Must be a string",
    "string_pattern_mismatch": "Must be a valid email",
    "literal_error": "Must be one of: member, admin",
}


def _detail(error: Any) -> Detail:
    field = str(error["loc"][0]) if error["loc"] else ""
    kind = error["type"]
    if kind == "extra_forbidden":
        message = "Field is read-only" if field in READ_ONLY else "Unknown field"
    elif kind != "missing" and error.get("input", ...) is None:
        message = "Cannot be null"
    else:
        message = _MESSAGES.get(kind) or error["msg"]
    return {"field": field, "message": message}


def parse_body[T: BaseModel](body: bytes, model: type[T]) -> T:
    """Parses a JSON object body into `model`, or raises the contract's 400."""
    try:
        data = orjson.loads(body)
    except orjson.JSONDecodeError:
        raise ApiError(400, "Invalid JSON body") from None
    if not isinstance(data, dict):
        raise ApiError(400, "Invalid body", [{"field": "", "message": "Body must be a JSON object"}])
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise ApiError(400, "Invalid body", [_detail(error) for error in exc.errors(include_url=False)]) from None
