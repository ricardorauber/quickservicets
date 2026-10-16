---
title: Profiles and organizations
description: Hold ordered lists of references with reference arrays, and attach a file.
sidebar:
  order: 3
---

A profile bundles permissions under a name, and an organization enables a set of modules. Both need a field that holds many references, so in this page you meet **reference arrays**, plus a file field for the organization's logo.

<details>
<summary>The entities so far</summary>

```ts check title="entities/Module.ts"
export enum ModuleAction {
    manage,
    view
}

export type Module = {
    slug: string
    active: boolean
}
```

```ts check title="entities/Permission.ts"
import { Module, ModuleAction } from "./Module"

export type Permission = {
    module: Module
    action: ModuleAction
}
```

</details>

## The Profile entity

Create `entities/Profile.ts`:

```ts check title="entities/Profile.ts"
import { Permission } from "./Permission"

export type Profile = {
    slug: string
    permissions: Permission[]
}
```

`permissions: Permission[]` is a reference array: an ordered list of permission ids. quickservice checks it for you:

- Every id must exist, and the same id may not appear twice.
- The order you send is the order you get back.
- When you leave it out on create, it is stored as `[]`, even though the field is not optional.

## The Organization entity

Create `entities/Organization.ts`. Organizations get their members on the next page, so for now they have no `members` field:

```ts check title="entities/Organization.ts"
import type { Media } from "@quickservice/core"
import { Module } from "./Module"

export type Organization = {
    slug: string
    legalName: string
    name?: string
    logo?: Media;
    active: boolean
    modules: Module[]
}
```

- `name?` is optional. When it has no value, responses return `null`.
- `logo?: Media` references a built-in file entity for images, audio and video. You upload the file in the same request that creates the organization.
- `modules: Module[]` is another reference array.

## Try it

Create a profile with two permissions (create a `reports` module and a `view` permission for it first, as on the previous page):

```bash
curl -X POST localhost:3000/profiles -d '{"slug":"finance","permissions":["<manage-billing-id>","<view-reports-id>"]}'
```

```json
{
  "slug": "finance",
  "permissions": ["01a1…1cb4", "01a1…e65c"],
  "id": "01a1…d244",
  "createdAt": "2026-10-16T22:25:16.498Z",
  "updatedAt": "2026-10-16T22:25:16.498Z"
}
```

Sending the same id twice fails at the position of the second one:

```bash
curl -X POST localhost:3000/profiles -d '{"slug":"dup","permissions":["<manage-billing-id>","<manage-billing-id>"]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "permissions[1]", "message": "Duplicate item" }]
  }
}
```

### Populate

Responses hold ids by default. Ask for the records instead with `populate`, and go one level deeper with a dotted path:

```bash
curl "localhost:3000/profiles/<finance-id>?populate=permissions.module"
```

```json
{
  "id": "01a1…d244",
  "createdAt": "2026-10-16T22:25:16.498Z",
  "updatedAt": "2026-10-16T22:25:16.498Z",
  "slug": "finance",
  "permissions": [
    {
      "id": "01a1…1cb4",
      "createdAt": "2026-10-16T22:25:16.497Z",
      "updatedAt": "2026-10-16T22:25:16.497Z",
      "module": {
        "id": "01a1…208c",
        "createdAt": "2026-10-16T22:25:16.497Z",
        "updatedAt": "2026-10-16T22:25:16.497Z",
        "slug": "billing",
        "active": true
      },
      "action": "manage"
    },
    {
      "id": "01a1…e65c",
      "createdAt": "2026-10-16T22:25:16.497Z",
      "updatedAt": "2026-10-16T22:25:16.497Z",
      "module": {
        "id": "01a1…25d2",
        "createdAt": "2026-10-16T22:25:16.497Z",
        "updatedAt": "2026-10-16T22:25:16.497Z",
        "slug": "reports",
        "active": true
      },
      "action": "view"
    }
  ]
}
```

### Add and remove items

Create an organization with one module:

```bash
curl -X POST localhost:3000/organizations \
  -d '{"slug":"acme","legalName":"Acme Inc.","active":true,"modules":["<billing-id>"]}'
```

```json
{
  "slug": "acme",
  "legalName": "Acme Inc.",
  "active": true,
  "modules": ["01a1…208c"],
  "id": "01a1…5802",
  "createdAt": "2026-10-16T22:25:16.499Z",
  "updatedAt": "2026-10-16T22:25:16.499Z",
  "name": null,
  "logo": null
}
```

`PATCH` can replace the whole list, or change it with `add` and `remove` without sending the rest:

```bash
curl -X PATCH localhost:3000/organizations/<acme-id> -d '{"modules":{"add":["<reports-id>"]}}'
```

```json
{
  "slug": "acme",
  "legalName": "Acme Inc.",
  "active": true,
  "modules": ["01a1…208c", "01a1…25d2"],
  "id": "01a1…5802",
  "createdAt": "2026-10-16T22:25:16.499Z",
  "updatedAt": "2026-10-16T22:25:16.500Z",
  "name": null,
  "logo": null
}
```

### Filter by an item

`contains` finds the records whose array holds an id. `fields` keeps the response short:

```bash
curl "localhost:3000/organizations?where[modules][contains]=<reports-id>&fields=slug,modules"
```

```json
{
  "data": [{ "slug": "acme", "modules": ["01a1…208c", "01a1…25d2"] }],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### Upload a logo

Send a `multipart/form-data` body to create the record and upload its file in one request:

```bash
curl -X POST localhost:3000/organizations \
  -F slug=globex -F legalName="Globex LLC" -F active=true -F "logo=@./logo.png;type=image/png"
```

```json
{
  "slug": "globex",
  "legalName": "Globex LLC",
  "logo": "01a1…6f56",
  "active": true,
  "modules": [],
  "id": "01a1…936a",
  "createdAt": "2026-10-16T22:25:16.506Z",
  "updatedAt": "2026-10-16T22:25:16.506Z",
  "name": null
}
```

`modules` was left out, so it is `[]`. Populate the logo to get its file details and URL:

```bash
curl "localhost:3000/organizations/<globex-id>?populate=logo&fields=slug,logo"
```

```json
{
  "slug": "globex",
  "logo": {
    "id": "01a1…6f56",
    "createdAt": "2026-10-16T22:25:16.505Z",
    "updatedAt": "2026-10-16T22:25:16.505Z",
    "filename": "logo.png",
    "mimeType": "image/png",
    "size": 4,
    "storage": "default",
    "url": "/media/01a1…6f56/file"
  }
}
```

### Deleting what others point to

A permission's `module` is required, so a module that permissions still reference cannot be deleted:

```bash
curl -X DELETE localhost:3000/modules/<reports-id>
```

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by permissions"
  }
}
```

Reference arrays work the other way by default: deleting a record removes its id from every array that holds it. The `@onDelete` tag changes both behaviors.

## Learn more

- [JSDoc tags](/reference/tags/): `@onDelete`, `@minItems`, `@maxItems`, `@maxSize` and `@accept`.
- [HTTP query parameters](/reference/http/): `populate`, `fields` and the operators of reference arrays.
- [Errors](/reference/errors/): what each message means.

## What's next

Add users and connect them to organizations and teams: [Users, memberships and teams](/tutorial/users-memberships-and-teams/).
