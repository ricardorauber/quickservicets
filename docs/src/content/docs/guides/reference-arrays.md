---
title: Reference arrays
description: Hold an ordered list of records of another entity, update it with add and remove, and filter by it.
sidebar:
  order: 21
---

A field typed as a list of another entity, like `members: User[]` (or `Array<User>`), is a **reference array**: an ordered list of ids of that entity's records. It has the same existence checks as a [single reference](/guides/references/), plus list rules, operations to add and remove ids, its own delete rules and its own filters.

## Declaring a reference array

```ts check title="entities/User.ts"
export type User = {
  name: string;
};
```

```ts check title="entities/Team.ts"
import type { User } from "./User.ts";

export type Team = {
  name: string;
  /** @maxItems 3 */
  members: User[];
};
```

In the examples on this page, the users Ana, Bruno, Carla and Davi have ids ending in `…74b4`, `…f4df`, `…9ab2` and `…089e`.

## Order and empty lists

The order you send is the order you get back:

```http
POST /teams
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…9ab2", "01a1…74b4", "01a1…f4df"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…9ab2", "01a1…74b4", "01a1…f4df"],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.508Z"
}
```

A reference array left out on create or replace is stored as `[]`, even when the field isn't optional:

```http
POST /teams
Content-Type: application/json

{
  "name": "Docs"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Docs",
  "members": [],
  "id": "01a1…bf72",
  "createdAt": "2026-10-16T22:35:18.509Z",
  "updatedAt": "2026-10-16T22:35:18.509Z"
}
```

`null` becomes `[]` on an optional reference array (`reviewers?: User[]`), and fails with `Cannot be null` on a required one like `members`.

## Validation

Each item must be the id of an existing record, and the same id can't appear twice. Errors point to the item by its index.

```http
POST /teams
Content-Type: application/json

{
  "name": "Ops",
  "members": ["01a1…74b4", "01a1…74b4"]
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members[1]",
        "message": "Duplicate item"
      }
    ]
  }
}
```

```http
POST /teams
Content-Type: application/json

{
  "name": "Ops",
  "members": ["01a1…74b4", "01a1…beef"]
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members[1]",
        "message": "Referenced record not found"
      }
    ]
  }
}
```

### Limits with `@minItems` and `@maxItems`

[`@minItems`](/reference/tags/#minitems) and [`@maxItems`](/reference/tags/#maxitems) limit the length of the list (`@minLength` and `@maxLength` work as aliases). `Team.members` allows three members at most:

```http
POST /teams
Content-Type: application/json

{
  "name": "Ops",
  "members": ["01a1…74b4", "01a1…f4df", "01a1…9ab2", "01a1…089e"]
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members",
        "message": "Must have at most 3 items"
      }
    ]
  }
}
```

`@unique` and `@index` don't apply to reference arrays and fail the build.

## Updating with `add` and `remove`

`PUT` and `PATCH` accept the full list, which replaces the stored one. `PATCH` also takes `{ "add": [...], "remove": [...] }`, with either key optional, so a client can change the list without sending all of it. Removing Carla from Core:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "remove": ["01a1…9ab2"]
  }
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…74b4", "01a1…f4df"],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.510Z"
}
```

How the operations combine:

- `remove` runs before `add`.
- Removing an id that isn't in the list is ignored.
- Adding an id that's already in the list keeps it where it is.
- New ids go to the end, in the order sent.

Here Davi is appended, Ana stays first, and removing Carla again changes nothing:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "add": ["01a1…089e", "01a1…74b4"],
    "remove": ["01a1…9ab2"]
  }
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…74b4", "01a1…f4df", "01a1…089e"],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.511Z"
}
```

The same checks apply to the resulting list, so adding a fourth member breaks `@maxItems 3`:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "add": ["01a1…9ab2"]
  }
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members",
        "message": "Must have at most 3 items"
      }
    ]
  }
}
```

The same id in `add` and `remove` is a conflict:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "add": ["01a1…74b4"],
    "remove": ["01a1…74b4"]
  }
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members",
        "message": "Conflicting operations"
      }
    ]
  }
}
```

Any other key is rejected:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "move": ["01a1…74b4"]
  }
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members.move",
        "message": "Unknown field"
      }
    ]
  }
}
```

To reorder, send the full list:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": ["01a1…f4df", "01a1…74b4"]
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…f4df", "01a1…74b4"],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.512Z"
}
```

`add` and `remove` read the current list and write the result in one transaction, so two clients adding different members at the same time both get in. Any change to the list refreshes the record's `updatedAt`.

`PUT` replaces the whole record, so leaving `members` out empties it:

```http
PUT /teams/01a1…9ade
Content-Type: application/json

{
  "name": "Core"
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": [],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.513Z"
}
```

In code, `repos.teams.update(id, { members: { add: [userId] } })` takes the same operations.

## Delete rules

`@onDelete` on a reference array decides what happens to the list's owner when one of the listed records is deleted:

| Value | When a listed record is deleted |
| --- | --- |
| `pull` (default) | Its id is removed from the list; the other items keep their order. |
| `restrict` | The delete fails with 409 while any list holds the id. |
| `cascade` | Every record whose list holds the id is deleted. |

`setNull` doesn't apply to lists and fails the build.

### `pull`

`Team.members` has no `@onDelete`, so it uses `pull`. Core now lists Ana, Bruno and Carla, and Docs lists only Bruno. Deleting Bruno:

```http
DELETE /users/01a1…f4df
```

```http
HTTP/1.1 204 No Content
```

```http
GET /teams?fields=name,members
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Ops",
      "members": []
    },
    {
      "name": "Docs",
      "members": []
    },
    {
      "name": "Core",
      "members": ["01a1…74b4", "01a1…9ab2"]
    }
  ],
  "total": 3,
  "limit": 20,
  "offset": 0
}
```

Each changed team gets a newer `updatedAt`.

A pull never leaves a list shorter than its `@minItems`. When it would, the delete fails with 409 before anything changes, and the message names the first list that would drop below its minimum. Had `Team.members` been declared `/** @minItems 1 */ members: User[];`, deleting Bruno while Docs listed only him would fail:

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: teams.members would have fewer than 1 item"
  }
}
```

Bruno and every team stay unchanged. Add another member to Docs, or delete the team, then delete Bruno.

### `restrict`

```ts check title="entities/Project.ts"
import type { User } from "./User.ts";

export type Project = {
  name: string;
  /** @onDelete restrict */
  reviewers?: User[];
};
```

```http
POST /projects
Content-Type: application/json

{
  "name": "Website",
  "reviewers": ["01a1…9ab2"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Website",
  "reviewers": ["01a1…9ab2"],
  "id": "01a1…9dd7",
  "createdAt": "2026-10-16T22:35:18.513Z",
  "updatedAt": "2026-10-16T22:35:18.513Z"
}
```

While Carla reviews the Website project, she can't be deleted:

```http
DELETE /users/01a1…9ab2
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by projects"
  }
}
```

### `cascade`

```ts check title="entities/Channel.ts"
import type { User } from "./User.ts";

export type Channel = {
  name: string;
  /** @onDelete cascade */
  owners: User[];
};
```

```http
POST /channels
Content-Type: application/json

{
  "name": "general",
  "owners": ["01a1…089e"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "general",
  "owners": ["01a1…089e"],
  "id": "01a1…bd82",
  "createdAt": "2026-10-16T22:35:18.513Z",
  "updatedAt": "2026-10-16T22:35:18.513Z"
}
```

Deleting Davi deletes the channels he owns:

```http
DELETE /users/01a1…089e
```

```http
HTTP/1.1 204 No Content
```

```http
GET /channels/01a1…bd82
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": {
    "code": "NOT_FOUND",
    "message": "Channel not found"
  }
}
```

Lists take part in the same delete plan as [single references](/guides/references/#how-a-delete-is-planned): cascades are followed recursively, a `restrict` anywhere in the plan blocks everything, and all changes run in one transaction.

## Filters

On the list route, reference arrays take their own operators:

| Filter | Matches records whose list |
| --- | --- |
| `where[members][contains]=<id>` | holds the id |
| `where[members][containsAny]=<id>,<id>` | holds at least one of the ids (up to 100) |
| `where[members][containsAll]=<id>,<id>` | holds every one of the ids (up to 100) |
| `where[members][size][<op>]=<n>` | has a length that compares to `n` with `eq`, `ne`, `gt`, `gte`, `lt` or `lte` |
| `where[members][isEmpty]=true` | is empty (`false` for non-empty) |

For these examples, Core lists Ana, Bruno and Carla, Docs lists Bruno, and Ops is empty.

```http
GET /teams?where[members][contains]=01a1…74b4&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

```http
GET /teams?where[members][containsAny]=01a1…74b4,01a1…f4df&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Docs"
    },
    {
      "name": "Core"
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

```http
GET /teams?where[members][containsAll]=01a1…74b4,01a1…f4df&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

```http
GET /teams?where[members][size][gte]=2&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

```http
GET /teams?where[members][isEmpty]=true&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Ops"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

Other operators fail with 400, and so does sorting by a reference array:

```http
GET /teams?where[members][gt]=1
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query",
    "details": [
      {
        "field": "where[members][gt]",
        "message": "Operator \"gt\" is not allowed for this field"
      }
    ]
  }
}
```

```http
GET /teams?sort=members
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query",
    "details": [
      {
        "field": "sort",
        "message": "Field \"members\" cannot be sorted"
      }
    ]
  }
}
```

A reference array hidden from the list route (for example with `@hidden:list`) can't be filtered either.

## Storage and `@joinTable`

On SQLite and PostgreSQL, each reference array is stored in a junction table with the owner's id, the target's id and the item's position, named `<table>__<field in snake_case>` by default (`teams__members` here). Its rows go away with the owner, and reading a page of records loads each list with a single query. On MongoDB and in memory, the list is an array of ids inside the record.

[`@joinTable`](/reference/tags/#jointable) picks another name for the junction table:

```ts check title="entities/Organization.ts"
import type { User } from "./User.ts";

export type Organization = {
  name: string;
  /** @joinTable organization_members */
  members: User[];
};
```

- The name must match `^[a-z][a-z0-9_]*$`, and it can't be the name of an entity table or another junction table in the same schema.
- On MongoDB and in memory, there's no junction table for a reference array, so the build ignores the tag and warns: `entities/Organization.ts: @joinTable on field "members" is ignored on memory (reference arrays are embedded)`.
- When only the name changes, `migration add` generates a rename and keeps the data.

`@joinTable` also names the shared table of an N-N relation, as shown in [Bidirectional relations](/guides/relations/#join-tables).

## Populating

`?populate=members` returns the listed records in order instead of their ids. See [Populate](/guides/populate/#reference-arrays).

## Related reference

- Tags: [`@onDelete`](/reference/tags/#ondelete), [`@minItems`](/reference/tags/#minitems), [`@maxItems`](/reference/tags/#maxitems), [`@joinTable`](/reference/tags/#jointable)
- [Filter operators by field type](/reference/http/#filter-operators-by-field-type)
- [Repository `update`](/reference/api/#update)
- [Error messages](/reference/errors/#messages)

Next: [Bidirectional relations](/guides/relations/).
