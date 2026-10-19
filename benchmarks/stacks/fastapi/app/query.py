"""The list query language of the contract (limit, offset, sort, where, fields, populate), compiled to SQL."""

import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .common import ApiError, Detail

DEFAULT_LIMIT = 20
MAX_LIMIT = 100
MAX_LIST_VALUES = 100

FILTER_OPERATORS = frozenset(
    ["eq", "ne", "in", "nin", "gt", "gte", "lt", "lte", "contains", "startsWith", "exists", "isNull",
     "containsAny", "containsAll", "size", "isEmpty"]
)
_COMMON = ("eq", "ne", "in", "nin", "exists", "isNull")
OPERATORS_BY_TYPE = {
    "id": frozenset(_COMMON),
    "enum": frozenset(_COMMON),
    "string": frozenset(_COMMON + ("contains", "startsWith")),
    "number": frozenset(_COMMON + ("gt", "gte", "lt", "lte")),
    "date": frozenset(_COMMON + ("gt", "gte", "lt", "lte")),
}
COMPARISONS = {"eq": "=", "ne": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}

WHERE_KEY = re.compile(r"^where\[([^\]]+)\]\[([^\]]+)\]$")
INTEGER = re.compile(r"^-?\d+$")
ISO_8601 = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$")


@dataclass(frozen=True, slots=True)
class Field:
    name: str
    column: str | None  # None for the reference array, which lives in the junction table
    type: str
    values: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Collection:
    table: str
    fields: dict[str, Field]
    references: frozenset[str]  # fields that can be populated

    def columns(self) -> list[Field]:
        return [f for f in self.fields.values() if f.column is not None]


def _collection(table: str, fields: list[Field], references: tuple[str, ...] = ()) -> Collection:
    return Collection(table, {f.name: f for f in fields}, frozenset(references))


_SYSTEM = [Field("id", "id", "id"), Field("createdAt", "created_at", "date"), Field("updatedAt", "updated_at", "date")]
USERS = _collection(
    "users",
    _SYSTEM
    + [
        Field("email", "email", "string"),
        Field("name", "name", "string"),
        Field("role", "role", "enum", ("member", "admin")),
        Field("age", "age", "number"),
    ],
)
ORGANIZATIONS = _collection(
    "organizations",
    _SYSTEM + [Field("name", "name", "string"), Field("slug", "slug", "string"), Field("members", None, "refArray")],
    ("members",),
)


@dataclass(slots=True)
class ListQuery:
    where: str  # "" or " WHERE ..."
    args: list[Any]
    order_by: str
    limit: int
    offset: int


def _convert(raw: str, field: Field) -> tuple[Any, str | None]:
    """A query string value converted to the field's type, or the error clients read."""
    match field.type:
        case "number":
            try:
                value = float(raw) if raw.strip() and "_" not in raw else math.nan
            except ValueError:
                value = math.nan
            return (value, None) if math.isfinite(value) else (None, "Must be a number")
        case "date":
            if ISO_8601.match(raw):
                try:
                    value = datetime.fromisoformat(raw)
                    return (value if value.tzinfo else value.replace(tzinfo=UTC)), None
                except ValueError:
                    pass
            return None, "Must be an ISO 8601 date"
        case "enum":
            return (raw, None) if raw in field.values else (None, f"Must be one of: {', '.join(field.values)}")
        case _:
            return raw, None


def _like_pattern(value: str, prefix_only: bool) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}%" if prefix_only else f"%{escaped}%"


def _condition(
    name: str, op: str, raw: str, param: str, collection: Collection, args: list[Any], errors: list[Detail]
) -> str | None:
    field = collection.fields.get(name)
    if field is None or field.column is None:
        errors.append({"field": param, "message": f'Field "{name}" cannot be filtered'})
        return None
    if op not in FILTER_OPERATORS:
        errors.append({"field": param, "message": f'Unknown operator "{op}"'})
        return None
    if op not in OPERATORS_BY_TYPE[field.type]:
        errors.append({"field": param, "message": f'Operator "{op}" is not allowed for this field'})
        return None
    column = field.column
    if op in ("exists", "isNull"):
        if raw not in ("true", "false"):
            errors.append({"field": param, "message": "Must be true or false"})
            return None
        is_null = (raw == "true") == (op == "isNull")
        return f"{column} IS NULL" if is_null else f"{column} IS NOT NULL"
    if op in ("in", "nin"):
        items = [item.strip() for item in raw.split(",")]
        items = [item for item in items if item]
        if not items:
            errors.append({"field": param, "message": "Must list at least one value"})
            return None
        if len(items) > MAX_LIST_VALUES:
            errors.append({"field": param, "message": f"Must list at most {MAX_LIST_VALUES} values"})
            return None
        values = []
        for item in items:
            value, error = _convert(item, field)
            if error:
                errors.append({"field": param, "message": error})
                return None
            values.append(value)
        args.append(values)
        return f"{column} = ANY(${len(args)})" if op == "in" else f"{column} <> ALL(${len(args)})"
    value, error = _convert(raw, field)
    if error:
        errors.append({"field": param, "message": error})
        return None
    if op in ("contains", "startsWith"):
        args.append(_like_pattern(value, op == "startsWith"))
        return f"{column} ILIKE ${len(args)}"
    args.append(value)
    return f"{column} {COMPARISONS[op]} ${len(args)}"


def _sort(raw: str | None, collection: Collection, errors: list[Detail]) -> str:
    if raw is None:
        return "created_at DESC, id DESC"
    parts: list[str] = []
    seen: set[str] = set()
    for item in raw.split(","):
        item = item.strip()
        descending = item.startswith("-")
        name = item[1:] if descending else item
        field = collection.fields.get(name)
        if field is None or field.column is None:
            errors.append({"field": "sort", "message": f'Field "{name}" cannot be sorted'})
            continue
        if name in seen:
            errors.append({"field": "sort", "message": f'Field "{name}" is listed more than once'})
            continue
        seen.add(name)
        parts.append(f"{field.column} DESC" if descending else f"{field.column} ASC")
    if "id" not in seen:
        parts.append("id DESC")
    return ", ".join(parts)


def _integer(raw: str | None, name: str, minimum: int, maximum: int | None, fallback: int, errors: list[Detail]) -> int:
    if raw is None:
        return fallback
    value = int(raw) if INTEGER.match(raw) else None
    if value is None or value < minimum or (maximum is not None and value > maximum):
        message = f"Must be an integer of at least {minimum}" if maximum is None else f"Must be an integer from {minimum} to {maximum}"
        errors.append({"field": name, "message": message})
        return fallback
    return value


def parse_list_query(params: list[tuple[str, str]], collection: Collection) -> ListQuery:
    """Validates every parameter of a list route and reports all problems together."""
    errors: list[Detail] = []
    seen: set[str] = set()
    single: dict[str, str] = {}
    conditions: list[str] = []
    args: list[Any] = []
    for key, raw in params:
        if key in seen:
            errors.append({"field": key, "message": "Parameter is repeated"})
            continue
        seen.add(key)
        if key.startswith("where") and (match := WHERE_KEY.match(key)):
            condition = _condition(match[1], match[2], raw, key, collection, args, errors)
            if condition:
                conditions.append(condition)
        elif key in ("sort", "limit", "offset"):
            single[key] = raw
        elif key not in ("fields", "populate"):
            errors.append({"field": key, "message": "Unknown parameter"})
    order_by = _sort(single.get("sort"), collection, errors)
    limit = _integer(single.get("limit"), "limit", 1, MAX_LIMIT, DEFAULT_LIMIT, errors)
    offset = _integer(single.get("offset"), "offset", 0, None, 0, errors)
    if errors:
        raise ApiError(400, "Invalid query", errors)
    where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
    return ListQuery(where, args, order_by, limit, offset)


def first(params: list[tuple[str, str]], name: str) -> str | None:
    for key, value in params:
        if key == name:
            return value
    return None


def parse_populate(params: list[tuple[str, str]], collection: Collection) -> bool:
    """Whether `populate=members` was asked for; anything that is not a reference is a 400."""
    raw = first(params, "populate")
    if raw is None:
        return False
    paths = [path.strip() for path in raw.split(",")]
    paths = [path for path in paths if path]
    for path in paths:
        if path not in collection.references:
            message = f"Cannot populate: {path}"
            raise ApiError(400, message, [{"field": "populate", "message": message}])
    return bool(paths)


def parse_fields(params: list[tuple[str, str]], collection: Collection) -> list[str] | None:
    """The selected top-level fields, or None for every field."""
    raw = first(params, "fields")
    if raw is None:
        return None
    names = list(dict.fromkeys(name for name in (part.strip() for part in raw.split(",")) if name))
    if not names:
        raise ApiError(400, "Invalid query", [{"field": "fields", "message": "Must list at least one field"}])
    unknown = [name for name in names if name not in collection.fields]
    if unknown:
        raise ApiError(400, "Invalid query", [{"field": "fields", "message": f"Unknown field: {name}"} for name in unknown])
    return names
