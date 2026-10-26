# Validation and error messages

> How create, replace and update bodies are checked, and the errors clients get back.

Every body sent to a generated write route is checked against the entity before anything reaches the database. The same checks run when your code calls `create`, `replace` or `update` on a repository. Validation collects every problem in one response, so a client can fix them all at once.

The examples on this page use these two entities:

```ts title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  /** @minLength 2 @maxLength 40 */
  name: string;
  /** @min 0 @max 150 */
  age?: number;
  /** @default 'member' */
  role: "member" | "admin";
  active?: boolean;
  birthday?: Date;
  /** @format url */
  website?: string;
  /** @maxItems 3 */
  tags: string[];
  address?: { city: string; zip?: string };
};
```

```ts title="entities/Team.ts"
import type { User } from "./User";

export type Team = {
  name: string;
  /** @maxItems 2 */
  members: User[];
  lead?: User;
};
```

## The error body

A body that fails validation gets a 400 response with the code `VALIDATION_ERROR`, the message `Invalid body` and one entry in `details` per problem:

```bash
curl -X POST localhost:3000/users -d '{"email":"ana","nickname":"Ani","id":"123"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "id", "message": "Field is read-only" },
      { "field": "email", "message": "Must be a valid email" },
      { "field": "name", "message": "Is required" },
      { "field": "tags", "message": "Is required" },
      { "field": "nickname", "message": "Unknown field" }
    ]
  }
}
```

- `field` is the path of the value: `address.city` inside an object, `tags[1]` inside an array.
- Each field gets at most one message: the first check it fails.
- Read-only system fields come first, then the entity's fields in declaration order, then unknown fields.

Every status, code and message is listed in the [errors reference](/reference/errors/).

## Create, replace and update

The three write routes differ only in which fields must be present:

| Route | Mode | Required fields |
| --- | --- | --- |
| `POST /users` | create | Every required field, except those with a [`@default`](/reference/tags/#default) |
| `PUT /users/:id` | replace | Every required field, **including** those with a `@default` |
| `PATCH /users/:id` | update | None: absent fields keep their values |

In every mode, a field marked `?:` may be left out, and a [reference array](/guides/references/) is never required: when it is left out on create or replace, it is stored as `[]`.

On create, `@default` fills in what the body leaves out, and optional fields left out are returned as `null`:

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@example.com","name":"Ana","tags":[]}'
```

```json
{
  "email": "ana@example.com",
  "name": "Ana",
  "tags": [],
  "role": "member",
  "id": "01a146d1-db03-70b5-a935-555f0027c6d2",
  "createdAt": "2026-10-16T22:25:20.645Z",
  "updatedAt": "2026-10-16T22:25:20.645Z",
  "age": null,
  "active": null,
  "birthday": null,
  "website": null,
  "address": null
}
```

Replace sends the whole record, so defaults do not apply and `role` must be there:

```bash
curl -X PUT localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"email":"ana@example.com","name":"Ana"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "role", "message": "Is required" },
      { "field": "tags", "message": "Is required" }
    ]
  }
}
```

A successful replace clears the optional fields it leaves out. An update changes only what it sends:

```bash
curl -X PATCH localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"name":"Ana Souza","age":31}'
```

```json
{
  "email": "ana@example.com",
  "name": "Ana Souza",
  "tags": [],
  "role": "member",
  "id": "01a146d1-db03-70b5-a935-555f0027c6d2",
  "createdAt": "2026-10-16T22:25:20.645Z",
  "updatedAt": "2026-10-16T22:25:20.646Z",
  "age": 31,
  "active": null,
  "birthday": null,
  "website": null,
  "address": null
}
```

The reference array `members` of `Team` is required in the type, yet a create without it works:

```bash
curl -X POST localhost:3000/teams -d '{"name":"Core"}'
```

```json
{
  "name": "Core",
  "members": [],
  "id": "01a146d1-db07-7016-8816-640f032c1a33",
  "createdAt": "2026-10-16T22:25:20.647Z",
  "updatedAt": "2026-10-16T22:25:20.647Z",
  "lead": null
}
```

### Nested objects

An object value is always checked as a whole, even in an update: sending `address` replaces the stored address, so its required properties must be there.

```bash
curl -X PATCH localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"address":{"zip":"01000"}}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "address.city", "message": "Is required" }]
  }
}
```

## Null

- `null` on an **optional** field clears it. On an optional reference array, it stores `[]`.
- `null` on a **required** field, a required reference array included, fails with `Cannot be null`.
- `null` as an array item fails with `Cannot be null` at that item, such as `tags[0]`.

```bash
curl -X PATCH localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"age":null,"name":null}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "name", "message": "Cannot be null" }]
  }
}
```

The same body without `name` succeeds and returns `"age": null`.

## Type messages

| Field type | Message |
| --- | --- |
| `string` | `Must be a string`; `Must not contain NUL characters` for a value holding U+0000 |
| `number` | `Must be a number` (also for `NaN` and infinite values) |
| `boolean` | `Must be a boolean` |
| `Date` | `Must be an ISO 8601 date` |
| enum or union | `Must be one of: <values>` |
| array | `Must be an array` |
| object | `Must be an object` |
| reference | `Must be a string` (a non-empty id) |
| reference array | `Must be an array`; each item `Must be a string`, and `Duplicate item` for an id sent twice |

A `Date` field takes an ISO 8601 string: a date (`2026-03-01`) or a date and time (`2026-03-01T10:00:00Z`, with or without seconds and offset).

```bash
curl -X POST localhost:3000/users -d '{"email":1,"name":true,"age":"30","active":"yes","birthday":"yesterday","role":"root","tags":"a","address":"Rio"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "email", "message": "Must be a string" },
      { "field": "name", "message": "Must be a string" },
      { "field": "age", "message": "Must be a number" },
      { "field": "role", "message": "Must be one of: member, admin" },
      { "field": "active", "message": "Must be a boolean" },
      { "field": "birthday", "message": "Must be an ISO 8601 date" },
      { "field": "tags", "message": "Must be an array" },
      { "field": "address", "message": "Must be an object" }
    ]
  }
}
```

Inside arrays and objects the path points at the exact value:

```bash
curl -X POST localhost:3000/users -d '{"email":"bo@example.com","name":"Bo","tags":["a",2],"address":{"city":1,"country":"BR"}}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "tags[1]", "message": "Must be a string" },
      { "field": "address.city", "message": "Must be a string" },
      { "field": "address.country", "message": "Unknown field" }
    ]
  }
}
```

## Tag messages

| Tag | Message |
| --- | --- |
| [`@minLength`](/reference/tags/#minlength) on a string | `Must be at least <n> characters` |
| [`@maxLength`](/reference/tags/#maxlength) on a string | `Must be at most <n> characters` |
| [`@minItems`](/reference/tags/#minitems), or `@minLength` on an array | `Must have at least <n> items` |
| [`@maxItems`](/reference/tags/#maxitems), or `@maxLength` on an array | `Must have at most <n> items` |
| [`@min`](/reference/tags/#min) | `Must be at least <n>` |
| [`@max`](/reference/tags/#max) | `Must be at most <n>` |
| [`@format`](/reference/tags/#format) `email` | `Must be a valid email` |
| [`@format`](/reference/tags/#format) `url` | `Must be a valid URL` (only `http` and `https`) |

The limits are inclusive: with `@min 0`, the value `0` passes.

```bash
curl -X POST localhost:3000/users -d '{"email":"bo@","name":"B","age":-1,"website":"ftp://x.co","tags":["a","b","c","d"]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "email", "message": "Must be a valid email" },
      { "field": "name", "message": "Must be at least 2 characters" },
      { "field": "age", "message": "Must be at least 0" },
      { "field": "website", "message": "Must be a valid URL" },
      { "field": "tags", "message": "Must have at most 3 items" }
    ]
  }
}
```

## Unknown and read-only fields

- A field the entity does not declare fails with `Unknown field`, at the top level and inside objects (`address.country` above).
- `id`, `createdAt` and `updatedAt` fail with `Field is read-only` in every mode. The framework sets them.
- Fields the framework manages, like the metadata of file entities, are read-only as well.

```bash
curl -X PUT localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"email":"ana@example.com","name":"Ana","role":"admin","tags":[],"createdAt":"2020-01-01"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "createdAt", "message": "Field is read-only" }]
  }
}
```

## Bodies that are not objects

A body that is not valid JSON gets `Invalid JSON body`, and a JSON value that is not an object gets one detail with an empty `field`:

```bash
curl -X POST localhost:3000/users -d '{"email":'
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid JSON body" } }
```

```bash
curl -X POST localhost:3000/users -d '[]'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "", "message": "Body must be a JSON object" }]
  }
}
```

## Checks against the database

Some rules need the stored data, so they run after the body is valid:

- A [`@unique`](/reference/tags/#unique) field whose value another record already has fails with 409 `CONFLICT`.
- A reference, or a reference array item, pointing to a record that does not exist fails with 400 `Referenced record not found`.

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@example.com","name":"Ana Two","tags":[]}'
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

```bash
curl -X POST localhost:3000/teams -d '{"name":"Core","members":["01a146d1-db03-70b5-a935-555f0027c6d2","01a146d1-0000-7000-8000-000000000000"]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "members[1]", "message": "Referenced record not found" }]
  }
}
```

The same id twice in a reference array fails before that, with `Duplicate item` at the second occurrence:

```bash
curl -X POST localhost:3000/teams -d '{"name":"Core","members":["01a146d1-db03-70b5-a935-555f0027c6d2","01a146d1-db03-70b5-a935-555f0027c6d2"],"lead":""}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "members[1]", "message": "Duplicate item" },
      { "field": "lead", "message": "Must be a string" }
    ]
  }
}
```

In an update, a reference array also accepts `{ "add": [...], "remove": [...] }` instead of the full list; see the [references guide](/guides/references/).

**Next:** [Field selection and hidden fields](/guides/field-selection/)
