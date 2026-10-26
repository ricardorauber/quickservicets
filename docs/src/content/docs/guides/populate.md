---
title: Populate
description: Return referenced records as objects instead of ids, from the query, entity tags, endpoint tags or code.
sidebar:
  order: 23
---

References and reference arrays come back as ids. **Populating** a path replaces those ids with the referenced records, loaded with one batched query per path, however many records the response has.

The examples on this page use these entities:

```ts check title="entities/Country.ts"
export type Country = {
  name: string;
  code: string;
};
```

```ts check title="entities/Organization.ts"
import type { Country } from "./Country.ts";

export type Organization = {
  name: string;
  country: Country;
};
```

```ts check title="entities/User.ts"
import type { Organization } from "./Organization.ts";

export type User = {
  name: string;
  /** @hidden */
  passwordHash: string;
  organization: Organization;
};
```

```ts check title="entities/Team.ts"
import type { User } from "./User.ts";

/** @populate:read members */
export type Team = {
  name: string;
  members: User[];
};
```

## `?populate=` on generated routes

The list and read routes take `populate`, a comma-separated list of reference paths. Without it, `organization` is an id:

```http
GET /users/01a1…05a8
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…05a8",
  "createdAt": "2026-10-16T22:40:43.795Z",
  "updatedAt": "2026-10-16T22:40:43.795Z",
  "name": "Ana",
  "organization": "01a1…b81a"
}
```

With it, the organization is a record:

```http
GET /users/01a1…05a8?populate=organization
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…05a8",
  "createdAt": "2026-10-16T22:40:43.795Z",
  "updatedAt": "2026-10-16T22:40:43.795Z",
  "name": "Ana",
  "organization": {
    "id": "01a1…b81a",
    "createdAt": "2026-10-16T22:40:43.795Z",
    "updatedAt": "2026-10-16T22:40:43.795Z",
    "name": "Acme",
    "country": "01a1…b1d2"
  }
}
```

A populated record shows what its entity shows on its own read route: fields hidden there, and `@hidden` fields like `passwordHash`, never appear. When a referenced record no longer exists, a single reference becomes `null`.

Only reads are populated: create, update and replace responses always return ids.

## Nested paths

Separate the segments of a path with dots to go deeper. `organization.country` populates the organization and, inside it, the country. [Field selection](/guides/field-selection/) can then reach inside the populated records:

```http
GET /users?populate=organization.country&fields=name,organization.country.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Bruno",
      "organization": {
        "country": {
          "name": "Brazil"
        }
      }
    },
    {
      "name": "Ana",
      "organization": {
        "country": {
          "name": "Brazil"
        }
      }
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

Every level of a populate path counts as populated, so `fields` and `exclude` can also select fields of the organization itself, without listing `organization` again:

```http
GET /users?populate=organization.country&fields=organization.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "organization": {
        "name": "Acme"
      }
    },
    {
      "organization": {
        "name": "Acme"
      }
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

`country` is left out because `fields` did not select it. A path inside a reference that is not populated fails, and so does a field the populated entity does not have:

```http
GET /users?fields=name,organization.name
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
        "field": "fields",
        "message": "Unknown field: organization.name"
      }
    ]
  }
}
```

Every segment of a path must be a reference or reference array field:

```http
GET /users?populate=name
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Cannot populate: name",
    "details": [
      {
        "field": "populate",
        "message": "Cannot populate: name"
      }
    ]
  }
}
```

## `populate.maxDepth`

A path can have at most `populate.maxDepth` segments, 2 by default:

```http
GET /teams?populate=members.organization.country
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Populate depth exceeds 2",
    "details": [
      {
        "field": "populate",
        "message": "Populate depth exceeds 2"
      }
    ]
  }
}
```

Raise it in the [configuration](/reference/config/) when you need deeper paths. It applies to the query parameter, the tags and the code below alike:

```ts check title="quickservicets.config.ts"
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  populate: { maxDepth: 3 },
});
```

## Reference arrays

A populated reference array lists the records in the stored order. Ids whose records no longer exist are left out, not returned as `null`. Paths can go through arrays (`members.organization`), and field selection applies to every item:

```http
GET /teams?populate=members&fields=name,members.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core",
      "members": [
        {
          "name": "Bruno"
        },
        {
          "name": "Ana"
        }
      ]
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

The derived sides of [bidirectional relations](/guides/relations/) populate the same way.

## Entity `@populate`

[`@populate`](/reference/tags/#populate) on an entity type populates paths by default. Scope it with `:list` or `:read`, or leave it unscoped for both. `Team` has `@populate:read members`, so its read route populates `members` with no parameter:

```http
GET /teams/01a1…a0ca?fields=name,members.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": [
    {
      "name": "Bruno"
    },
    {
      "name": "Ana"
    }
  ]
}
```

`?populate=` adds paths to the tag's:

```http
GET /teams/01a1…a0ca?populate=members.organization&fields=name,members.name,members.organization.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": [
    {
      "name": "Bruno",
      "organization": {
        "name": "Acme"
      }
    },
    {
      "name": "Ana",
      "organization": {
        "name": "Acme"
      }
    }
  ]
}
```

The list route isn't covered by `:read`, so it still returns ids:

```http
GET /teams?fields=name,members
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core",
      "members": ["01a1…0f74", "01a1…05a8"]
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

An invalid path or one deeper than `populate.maxDepth` in the tag fails the build, for example `entities/User.ts: invalid @populate: Cannot populate: email`.

## Endpoint `@populate`

A [custom endpoint](/guides/endpoints/) that overrides a generated list or read route can declare its own [`@populate`](/reference/tags/#populate-1). It replaces the entity's tag for that route and applies to whatever record, array or `{ data }` page the handler returns. Without it, the override keeps the entity's tag.

Endpoints get typed repositories from the types the build generates in `.generated/types.ts`. This excerpt shows the parts the examples below use, including the references maps that type populated records:

```ts check title=".generated/types.ts"
// Generated by quickservicets build. Do not edit. (excerpt)
import type { One, Repository } from "@quickservicets/core";

export type Country = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  code: string;
};

export type CountryReferences = Record<never, never>;

export type Organization = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  country: string;
};

export type OrganizationReferences = {
  country: One<Country, CountryReferences>;
};

export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  passwordHash?: string | null;
  organization: string;
};

export type UserReferences = {
  organization: One<Organization, OrganizationReferences>;
};

export interface GeneratedRepositories {
  organizations: Repository<Organization, OrganizationReferences>;
  users: Repository<User, UserReferences>;
}

declare module "@quickservicets/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

This endpoint replaces `GET /organizations/:id` and populates `country`:

```ts check title="endpoints/organizations/[id]/get.ts"
import { HttpError, type Endpoint } from "@quickservicets/core";

/** @populate country */
const handler: Endpoint = async (repos, req) => {
  const organization = await repos.organizations.findById(req.params.id!);
  if (!organization) throw new HttpError(404, "Organization not found");
  return organization;
};

export default handler;
```

```http
GET /organizations/01a1…b81a
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…b81a",
  "createdAt": "2026-10-16T22:40:43.795Z",
  "updatedAt": "2026-10-16T22:40:43.795Z",
  "name": "Acme",
  "country": {
    "id": "01a1…b1d2",
    "createdAt": "2026-10-16T22:40:43.791Z",
    "updatedAt": "2026-10-16T22:40:43.791Z",
    "name": "Brazil",
    "code": "BR"
  }
}
```

On an endpoint that doesn't override a list or read route, the tag fails the build: `endpoints/users/[id]/stats/get.ts: @populate is only allowed on endpoints that override a list or read route`.

## Populating in code

### `include(...)` in fluent queries

In endpoints and hooks, [`include(...)`](/reference/api/#include) on a fluent query populates paths on every record it returns. The result is typed at every level, so `user.organization?.country?.code` type-checks, and a path that doesn't exist doesn't:

```ts check title="endpoints/organizations/[id]/people/get.ts"
import type { Endpoint } from "@quickservicets/core";

type Person = { name: string; country: string | null };

/** @summary People of an organization, with their country code */
const handler: Endpoint<unknown, Person[]> = async (repos, req) => {
  const users = await repos.users
    .where((user) => user.organization.eq(req.params.id!))
    .orderBy((user) => user.name)
    .include("organization.country")
    .all();
  return users.map((user) => ({ name: user.name, country: user.organization?.country?.code ?? null }));
};

export default handler;
```

```http
GET /organizations/01a1…b81a/people
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

[
  {
    "name": "Ana",
    "country": "BR"
  },
  {
    "name": "Bruno",
    "country": "BR"
  }
]
```

`include` follows the same rules as `?populate=`, including `populate.maxDepth` and the `Populate depth exceeds <n>` error.

### The `populate` option

`findById`, `findOne` and `list` take a `populate` option with the same typing, and `findByIds` takes `include`:

```ts check
import type { Repositories } from "@quickservicets/core";

export async function countryOf(repos: Repositories, userId: string): Promise<string | null> {
  const user = await repos.users.findById(userId, { populate: ["organization.country"] });
  return user?.organization?.country?.name ?? null;
}
```

For records you already have, such as the result of a custom query, [`populate(records, paths)`](/reference/api/#populate) fills them in.

## Related reference

- [HTTP query parameters](/reference/http/): `populate` and `fields`
- [`@populate` on entities](/reference/tags/#populate) and [on endpoints](/reference/tags/#populate-1)
- [`populate.maxDepth`](/reference/config/)
- Repositories: [`include`](/reference/api/#include), [`findById`](/reference/api/#findbyid), [`findByIds`](/reference/api/#findbyids), [`populate`](/reference/api/#populate)
- [Error messages](/reference/errors/#messages), including `Populate depth exceeds <n>`

Next: [Custom endpoints and overrides](/guides/endpoints/).
