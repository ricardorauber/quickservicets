"""The benchmark API (benchmarks/CONTRACT.md) on FastAPI and asyncpg."""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response

from . import media
from .common import ApiError, JSONResponse, invalid_body, iso, now, number, uuid7
from .models import UserCreate, UserPatch, parse_body
from .query import ORGANIZATIONS, USERS, parse_fields, parse_list_query, parse_populate

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "uploads")


def _database_url() -> str:
    if url := os.environ.get("DATABASE_URL"):
        return url
    env = os.environ.get
    return (
        f"postgres://{env('DB_USER', 'bench')}:{env('DB_PASSWORD', 'bench')}"
        f"@{env('DB_HOST', 'localhost')}:{env('DB_PORT', '55432')}/{env('DB_NAME', 'bench')}"
    )


def _pool_size() -> int:
    """DB_POOL_SIZE is the total for the container, shared by the uvicorn worker processes."""
    total = int(os.environ.get("DB_POOL_SIZE", "10"))
    workers = int(os.environ.get("WEB_CONCURRENCY", "1"))
    return max(1, total // max(1, workers))


pool: asyncpg.Pool


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    global pool
    size = _pool_size()
    pool = await asyncpg.create_pool(_database_url(), min_size=size, max_size=size)
    try:
        yield
    finally:
        await pool.close()


app = FastAPI(
    lifespan=lifespan,
    default_response_class=JSONResponse,
    openapi_url=None,
    docs_url=None,
    redoc_url=None,
)


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> Response:
    return exc.response()


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_: Request, exc: StarletteHTTPException) -> Response:
    if exc.status_code == 404:
        return ApiError(404, "Route not found").response()
    if exc.status_code == 405:
        response = JSONResponse({"error": {"code": "METHOD_NOT_ALLOWED", "message": "Method not allowed"}}, status_code=405)
        response.headers.update(exc.headers or {})
        return response
    if exc.status_code == 400:
        # Starlette's form parser reports a malformed multipart body this way.
        return ApiError(400, str(exc.detail)).response()
    return JSONResponse({"error": {"code": "ERROR", "message": str(exc.detail)}}, status_code=exc.status_code)


@app.exception_handler(Exception)
async def internal_error_handler(_: Request, __: Exception) -> Response:
    return ApiError(500, "Internal server error").response()


def _conflict() -> ApiError:
    return ApiError(409, "Value already exists", [{"field": "email", "message": "Value already exists"}])


# --- Records -------------------------------------------------------------------------------------------------------

USER_COLUMNS = "id, created_at, updated_at, email, name, role, age"
ORGANIZATION_COLUMNS = "o.id, o.created_at, o.updated_at, o.name, o.slug"
MEMBER_IDS = "ARRAY(SELECT m.target_id FROM organizations__members m WHERE m.owner_id = o.id ORDER BY m.position)"
MEMBERS_OF = (
    "SELECT m.owner_id, u.id, u.created_at, u.updated_at, u.email, u.name, u.role, u.age"
    " FROM organizations__members m JOIN users u ON u.id = m.target_id"
)

_USER_CONVERTERS = {"createdAt": iso, "updatedAt": iso, "age": number}


def user_record(row: Any, at: int = 0) -> dict[str, Any]:
    """A full user record from the USER_COLUMNS of a row, starting at column `at`."""
    return {
        "id": row[at],
        "createdAt": iso(row[at + 1]),
        "updatedAt": iso(row[at + 2]),
        "email": row[at + 3],
        "name": row[at + 4],
        "role": row[at + 5],
        "age": number(row[at + 6]),
    }


def user_columns(fields: list[str] | None) -> str:
    return USER_COLUMNS if fields is None else ", ".join(USERS.fields[name].column for name in fields)  # type: ignore[misc]


def user_records(rows: list[Any], fields: list[str] | None) -> list[dict[str, Any]]:
    """Rows selected with user_columns(fields), as records with exactly those fields."""
    if fields is None:
        return [user_record(row) for row in rows]
    converters = [(index, name, _USER_CONVERTERS.get(name)) for index, name in enumerate(fields)]
    return [{name: convert(row[index]) if convert else row[index] for index, name, convert in converters} for row in rows]


def organization_record(row: Any, members: list[Any], fields: list[str] | None) -> dict[str, Any]:
    record = {
        "id": row[0],
        "createdAt": iso(row[1]),
        "updatedAt": iso(row[2]),
        "name": row[3],
        "slug": row[4],
        "members": members,
    }
    return record if fields is None else {name: record[name] for name in fields}


def media_record(row: Any) -> dict[str, Any]:
    return {
        "id": row[0],
        "createdAt": iso(row[1]),
        "updatedAt": iso(row[2]),
        "filename": row[3],
        "mimeType": row[4],
        "size": number(row[5]),
        "storage": "default",
        "url": f"/media/{row[0]}/file",
    }


# --- Health --------------------------------------------------------------------------------------------------------


@app.get("/health")
async def health() -> Response:
    return JSONResponse({"ok": True})


# --- Users ---------------------------------------------------------------------------------------------------------


@app.get("/users")
async def list_users(request: Request) -> Response:
    params = request.query_params.multi_items()
    parse_populate(params, USERS)
    fields = parse_fields(params, USERS)
    query = parse_list_query(params, USERS)
    n = len(query.args)
    sql = f"SELECT {user_columns(fields)} FROM users{query.where} ORDER BY {query.order_by} LIMIT ${n + 1} OFFSET ${n + 2}"
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *query.args, query.limit, query.offset)
        total = await conn.fetchval(f"SELECT count(*) FROM users{query.where}", *query.args)
    return JSONResponse({"data": user_records(rows, fields), "total": total, "limit": query.limit, "offset": query.offset})


@app.get("/users/{user_id}")
async def get_user(user_id: str, request: Request) -> Response:
    params = request.query_params.multi_items()
    parse_populate(params, USERS)
    fields = parse_fields(params, USERS)
    row = await pool.fetchrow(f"SELECT {user_columns(fields)} FROM users WHERE id = $1", user_id)
    if row is None:
        raise ApiError(404, "User not found")
    return JSONResponse(user_records([row], fields)[0])


@app.post("/users")
async def create_user(request: Request) -> Response:
    body = parse_body(await request.body(), UserCreate)
    user_id = uuid7()
    timestamp = now()
    try:
        await pool.execute(
            f"INSERT INTO users ({USER_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            user_id, timestamp, timestamp, body.email, body.name, body.role, body.age,
        )
    except asyncpg.UniqueViolationError as exc:
        if exc.constraint_name == "users_email_uq":
            raise _conflict() from None
        raise
    created = iso(timestamp)
    record = {"id": user_id, "createdAt": created, "updatedAt": created, "email": body.email, "name": body.name, "role": body.role, "age": body.age}
    return JSONResponse(record, status_code=201)


@app.patch("/users/{user_id}")
async def update_user(user_id: str, request: Request) -> Response:
    body = parse_body(await request.body(), UserPatch)
    given = body.model_fields_set
    assignments: list[str] = []
    args: list[Any] = [user_id]
    for name in ("email", "name", "role", "age"):  # the column names equal the field names
        if name in given:
            args.append(getattr(body, name))
            assignments.append(f"{name} = ${len(args)}")
    args.append(now())
    assignments.append(f"updated_at = ${len(args)}")
    try:
        row = await pool.fetchrow(f"UPDATE users SET {', '.join(assignments)} WHERE id = $1 RETURNING {USER_COLUMNS}", *args)
    except asyncpg.UniqueViolationError as exc:
        if exc.constraint_name == "users_email_uq":
            raise _conflict() from None
        raise
    if row is None:
        raise ApiError(404, "User not found")
    return JSONResponse(user_record(row))


# One statement, so one transaction: every sub-statement sees the memberships as they were before the delete
# (the junction rows go with the foreign key's cascade) and the owning organizations get their updatedAt moved.
DELETE_USER = """
WITH deleted AS (DELETE FROM users WHERE id = $1 RETURNING id),
touched AS (
  UPDATE organizations SET updated_at = $2
  WHERE id IN (SELECT owner_id FROM organizations__members WHERE target_id = $1)
)
SELECT count(*) FROM deleted
"""


@app.delete("/users/{user_id}")
async def delete_user(user_id: str) -> Response:
    if await pool.fetchval(DELETE_USER, user_id, now()) == 0:
        raise ApiError(404, "User not found")
    return Response(status_code=204)


# --- Organizations -------------------------------------------------------------------------------------------------


async def _populated_members(conn: asyncpg.Connection, organization_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """The member records of several organizations in one query, in position order."""
    members: dict[str, list[dict[str, Any]]] = {organization_id: [] for organization_id in organization_ids}
    if organization_ids:
        rows = await conn.fetch(f"{MEMBERS_OF} WHERE m.owner_id = ANY($1) ORDER BY m.owner_id, m.position", organization_ids)
        for row in rows:
            members[row[0]].append(user_record(row, 1))
    return members


def _organization_columns(fields: list[str] | None, populate: bool) -> tuple[str, bool, bool]:
    """The select list, whether members are returned, and whether they are read from the id array column."""
    with_members = fields is None or "members" in fields
    with_ids = with_members and not populate
    return (f"{ORGANIZATION_COLUMNS}, {MEMBER_IDS}" if with_ids else ORGANIZATION_COLUMNS), with_members, with_ids


@app.get("/organizations")
async def list_organizations(request: Request) -> Response:
    params = request.query_params.multi_items()
    populate = parse_populate(params, ORGANIZATIONS)
    fields = parse_fields(params, ORGANIZATIONS)
    query = parse_list_query(params, ORGANIZATIONS)
    columns, with_members, with_ids = _organization_columns(fields, populate)
    n = len(query.args)
    sql = f"SELECT {columns} FROM organizations o{query.where} ORDER BY {query.order_by} LIMIT ${n + 1} OFFSET ${n + 2}"
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *query.args, query.limit, query.offset)
        total = await conn.fetchval(f"SELECT count(*) FROM organizations o{query.where}", *query.args)
        populated = await _populated_members(conn, [row[0] for row in rows]) if with_members and not with_ids else None
    if populated is not None:
        data = [organization_record(row, populated[row[0]], fields) for row in rows]
    else:
        data = [organization_record(row, list(row[5]) if with_ids else [], fields) for row in rows]
    return JSONResponse({"data": data, "total": total, "limit": query.limit, "offset": query.offset})


@app.get("/organizations/{organization_id}")
async def get_organization(organization_id: str, request: Request) -> Response:
    params = request.query_params.multi_items()
    populate = parse_populate(params, ORGANIZATIONS)
    fields = parse_fields(params, ORGANIZATIONS)
    columns, with_members, with_ids = _organization_columns(fields, populate)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(f"SELECT {columns} FROM organizations o WHERE o.id = $1", organization_id)
        if row is None:
            raise ApiError(404, "Organization not found")
        if with_members and not with_ids:
            members: list[Any] = (await _populated_members(conn, [organization_id]))[organization_id]
        else:
            members = list(row[5]) if with_ids else []
    return JSONResponse(organization_record(row, members, fields))


ORGANIZATION_STATS = """
SELECT EXISTS (SELECT 1 FROM organizations WHERE id = $1),
       count(u.id),
       count(u.id) FILTER (WHERE u.role = 'admin'),
       avg(u.age)
FROM organizations__members m JOIN users u ON u.id = m.target_id
WHERE m.owner_id = $1
"""


@app.get("/organizations/{organization_id}/stats")
async def organization_stats(organization_id: str) -> Response:
    found, members, admins, average_age = await pool.fetchrow(ORGANIZATION_STATS, organization_id)
    if not found:
        raise ApiError(404, "Organization not found")
    return JSONResponse({"members": members, "admins": admins, "averageAge": average_age})


# --- Media ---------------------------------------------------------------------------------------------------------

MEDIA_COLUMNS = "id, created_at, updated_at, filename, mime_type, size"


@app.post("/media")
async def upload_media(request: Request) -> Response:
    if media.essence(request.headers.get("content-type")) != "multipart/form-data":
        raise ApiError(415, "Must be multipart/form-data")
    async with request.form() as form:
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise invalid_body("file", "Is required")

        head = await file.read(64)
        detected = media.detect(head)
        declared = media.essence(file.content_type)
        if detected is None:
            mime_type = declared
        elif declared in ("", "application/octet-stream", detected):
            mime_type = detected
        else:
            raise ApiError(
                415,
                "File content does not match its type",
                [{"field": "file", "message": f"Detected {detected}, declared {declared}"}],
            )
        size = file.size if file.size is not None else len(head)
        if size > media.MAX_SIZE:
            raise ApiError(413, "File too large")
        if mime_type not in media.ACCEPT:
            raise invalid_body("file", "File type not allowed")
        extra = [
            {"field": name, "message": "Field is read-only" if name in media.MANAGED_FIELDS else "Unknown field"}
            for name in dict.fromkeys(form.keys())
            if name != "file"
        ]
        if extra:
            raise ApiError(400, "Invalid body", extra)

        await file.seek(0)
        data = await file.read()
        filename = media.sanitize_filename(file.filename or "file")

    media_id = uuid7()
    storage_key = f"media/{media_id}/{uuid7()}{media.extension(filename)}"
    path = os.path.join(UPLOAD_DIR, storage_key)
    timestamp = now()
    await run_in_threadpool(media.write_file, path, data)
    try:
        await pool.execute(
            "INSERT INTO media (id, created_at, updated_at, filename, mime_type, size, storage, storage_key)"
            " VALUES ($1, $2, $3, $4, $5, $6, 'default', $7)",
            media_id, timestamp, timestamp, filename, mime_type, len(data), storage_key,
        )
    except BaseException:
        await run_in_threadpool(media.remove_file, path)
        raise
    return JSONResponse(media_record((media_id, timestamp, timestamp, filename, mime_type, float(len(data)))), status_code=201)


@app.get("/media/{media_id}")
async def get_media(media_id: str) -> Response:
    row = await pool.fetchrow(f"SELECT {MEDIA_COLUMNS} FROM media WHERE id = $1", media_id)
    if row is None:
        raise ApiError(404, "Media not found")
    return JSONResponse(media_record(row))


@app.get("/media/{media_id}/file")
async def get_media_file(media_id: str) -> Response:
    row = await pool.fetchrow("SELECT filename, mime_type, storage_key FROM media WHERE id = $1", media_id)
    if row is None:
        raise ApiError(404, "Media not found")
    filename, mime_type, storage_key = row
    data = await run_in_threadpool(media.read_file, os.path.join(UPLOAD_DIR, storage_key))
    if data is None:
        raise ApiError(404, "Media not found")
    return Response(data, media_type=mime_type, headers={"content-disposition": media.content_disposition(filename)})
