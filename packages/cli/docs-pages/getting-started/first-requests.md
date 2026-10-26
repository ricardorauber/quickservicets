# Your first requests

> Create, list, read, update and delete records with curl.

With `bun run dev` running from the [previous page](/getting-started/first-entity/), the API answers at `http://localhost:3000`. Open a second terminal and try each route.

Ids and timestamps below are shortened with `…`; yours will differ.

## Create

Send the fields as JSON to `POST /users`:

```bash
curl -X POST localhost:3000/users \
  -H "content-type: application/json" \
  -d '{"email":"ana@example.com","name":"Ana"}'
```

The response is `201 Created` with the new record. `role` got its default, and the system fields were added:

```json
{
  "email": "ana@example.com",
  "name": "Ana",
  "role": "member",
  "id": "01a146d2-1b32-708e-…",
  "createdAt": "2026-10-16T22:25:37.075Z",
  "updatedAt": "2026-10-16T22:25:37.075Z"
}
```

Create a second user to have something to filter:

```bash
curl -X POST localhost:3000/users \
  -H "content-type: application/json" \
  -d '{"email":"bruno@example.com","role":"admin"}'
```

```json
{
  "email": "bruno@example.com",
  "role": "admin",
  "id": "01a146d2-1b5a-74d9-…",
  "createdAt": "2026-10-16T22:25:37.114Z",
  "updatedAt": "2026-10-16T22:25:37.114Z",
  "name": null
}
```

Copy Ana's `id`: the next steps use it in place of `<id>`.

## When the body is wrong

The entity's rules are checked on every write. A bad body returns `400` with one entry per problem:

```bash
curl -X POST localhost:3000/users \
  -H "content-type: application/json" \
  -d '{"email":"not-an-email","role":"owner","age":30}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "email", "message": "Must be a valid email" },
      { "field": "role", "message": "Must be one of: member, admin" },
      { "field": "age", "message": "Unknown field" }
    ]
  }
}
```

Because `email` is `@unique`, reusing one returns `409 Conflict`:

```bash
curl -X POST localhost:3000/users \
  -H "content-type: application/json" \
  -d '{"email":"ana@example.com"}'
```

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Value already exists",
    "details": [{ "field": "email", "message": "Value already exists" }]
  }
}
```

Every error has this same shape. The [errors reference](/reference/errors/) lists each code and message.

## List

```bash
curl localhost:3000/users
```

`200 OK` with a page of records, newest first, and the paging values:

```json
{
  "data": [
    {
      "id": "01a146d2-1b5a-74d9-…",
      "createdAt": "2026-10-16T22:25:37.114Z",
      "updatedAt": "2026-10-16T22:25:37.114Z",
      "email": "bruno@example.com",
      "name": null,
      "role": "admin"
    },
    {
      "id": "01a146d2-1b32-708e-…",
      "createdAt": "2026-10-16T22:25:37.075Z",
      "updatedAt": "2026-10-16T22:25:37.075Z",
      "email": "ana@example.com",
      "name": "Ana",
      "role": "member"
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

`total` counts every matching record, not just this page. Use `limit` and `offset` to move through the pages:

```bash
curl "localhost:3000/users?limit=1&offset=1"
```

```json
{
  "data": [
    {
      "id": "01a146d2-1b32-708e-…",
      "createdAt": "2026-10-16T22:25:37.075Z",
      "updatedAt": "2026-10-16T22:25:37.075Z",
      "email": "ana@example.com",
      "name": "Ana",
      "role": "member"
    }
  ],
  "total": 2,
  "limit": 1,
  "offset": 1
}
```

### Filter, sort and pick fields

Filters use `where[<field>][<op>]=<value>`. This request keeps the admins, sorts by email and returns only two fields:

```bash
curl -g "localhost:3000/users?where[role][eq]=admin&sort=email&fields=email,role"
```

```json
{
  "data": [{ "email": "bruno@example.com", "role": "admin" }],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

> **Caution:**
>
> `curl` reads square brackets in a URL as a pattern and fails with `bad range in URL`. The `-g` flag turns that off. Browsers and HTTP clients need no flag.

The [HTTP query parameters reference](/reference/http/) lists every parameter and which operators each field type accepts.

## Read

```bash
curl localhost:3000/users/<id>
```

`200 OK` with the record:

```json
{
  "id": "01a146d2-1b32-708e-…",
  "createdAt": "2026-10-16T22:25:37.075Z",
  "updatedAt": "2026-10-16T22:25:37.075Z",
  "email": "ana@example.com",
  "name": "Ana",
  "role": "member"
}
```

`fields` works here too:

```bash
curl "localhost:3000/users/<id>?fields=email,name"
```

```json
{ "email": "ana@example.com", "name": "Ana" }
```

## Update

`PATCH` changes only the fields you send:

```bash
curl -X PATCH localhost:3000/users/<id> \
  -H "content-type: application/json" \
  -d '{"name":"Ana Souza"}'
```

`200 OK` with the updated record. `updatedAt` moved forward:

```json
{
  "email": "ana@example.com",
  "name": "Ana Souza",
  "role": "member",
  "id": "01a146d2-1b32-708e-…",
  "createdAt": "2026-10-16T22:25:37.075Z",
  "updatedAt": "2026-10-16T22:25:48.383Z"
}
```

`PUT` replaces the whole record instead. It needs every required field, `role` included, and optional fields you leave out become `null`:

```bash
curl -X PUT localhost:3000/users/<id> \
  -H "content-type: application/json" \
  -d '{"email":"ana@example.com","role":"admin"}'
```

```json
{
  "email": "ana@example.com",
  "name": null,
  "role": "admin",
  "id": "01a146d2-1b32-708e-…",
  "createdAt": "2026-10-16T22:25:37.075Z",
  "updatedAt": "2026-10-16T22:25:48.402Z"
}
```

## Delete

```bash
curl -i -X DELETE localhost:3000/users/<id>
```

The response is `204 No Content`, with no body:

```text
HTTP/1.1 204 No Content
```

Reading the user again now returns `404`:

```bash
curl localhost:3000/users/<id>
```

```json
{ "error": { "code": "NOT_FOUND", "message": "User not found" } }
```

## Next

[Project structure](/getting-started/project-structure/): what each file and folder of a project is for.
