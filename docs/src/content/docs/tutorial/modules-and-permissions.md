---
title: Modules and permissions
description: Write your first entities, a reference and an enum.
sidebar:
  order: 2
---

A module is a part of the product, like `billing`. A permission says what someone may do with a module: `manage` it or only `view` it. In this page you write both entities and meet two field kinds: a reference and an enum.

## The Module entity

An entity is an exported `type` in a file inside `entities/`. Create `entities/Module.ts`:

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

`Module` gets the routes `/modules` and `/modules/<id>`, and every record also has `id`, `createdAt` and `updatedAt`. The file exports `ModuleAction` too, which the permission uses next. An enum is not an entity, so it gets no routes.

## An enum without initializers

`ModuleAction` has no values after its members. In that case QuickService uses the member names as the values, so the API accepts and returns `"manage"` and `"view"`, never `0` or `1`.

Other string forms work the same way. All of these are valid:

```ts check
// A string enum
export enum Status { Draft = "draft", Published = "published" }

// An alias of a string union
export type Visibility = "public" | "private"

export type Post = {
    status: Status
    visibility: Visibility
    // An inline union
    kind: "news" | "event"
}
```

The build fails for enums that are not exported, that use numeric values, that mix members with and without values, or that repeat a value.

## The Permission entity

Create `entities/Permission.ts`:

```ts check title="entities/Permission.ts"
import { Module, ModuleAction } from "./Module"

export type Permission = {
    module: Module
    action: ModuleAction
}
```

- `module: Module` is a **reference**: it holds the id of a module. The module must exist when you save the permission.
- `action: ModuleAction` is an **enum field**: it accepts only `"manage"` or `"view"`.

## Try it

The dev server picks up the new files. Create a module:

```bash
curl -X POST localhost:3000/modules -d '{"slug":"billing","active":true}'
```

It answers `201 Created`:

```json
{
  "slug": "billing",
  "active": true,
  "id": "01a1…ed1e",
  "createdAt": "2026-10-16T22:25:12.262Z",
  "updatedAt": "2026-10-16T22:25:12.262Z"
}
```

:::tip
Ids are shortened with `…` on these pages. In your requests, replace placeholders like `<billing-id>` with the full ids from your own responses.
:::

Create a permission that references it:

```bash
curl -X POST localhost:3000/permissions -d '{"module":"<billing-id>","action":"manage"}'
```

```json
{
  "module": "01a1…ed1e",
  "action": "manage",
  "id": "01a1…73da",
  "createdAt": "2026-10-16T22:25:12.263Z",
  "updatedAt": "2026-10-16T22:25:12.263Z"
}
```

An action outside the enum fails with `400`, and so does a number such as `0`:

```bash
curl -X POST localhost:3000/permissions -d '{"module":"<billing-id>","action":"edit"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "action", "message": "Must be one of: manage, view" }]
  }
}
```

A module id that does not exist fails too:

```bash
curl -X POST localhost:3000/permissions -d '{"module":"nope","action":"view"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "module", "message": "Referenced record not found" }]
  }
}
```

After you also create a `view` permission for `billing`, filter by the enum value:

```bash
curl "localhost:3000/permissions?where[action][eq]=view"
```

```json
{
  "data": [
    {
      "id": "01a1…683f",
      "createdAt": "2026-10-16T22:25:12.263Z",
      "updatedAt": "2026-10-16T22:25:12.263Z",
      "module": "01a1…ed1e",
      "action": "view"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

:::caution
In your own code, such as custom endpoints, write the value as a string (`"manage"`). `ModuleAction.manage` is the number `0` at runtime, and the generated types reject it.
:::

:::note
The memory database starts empty each time the dev server restarts, for example after you edit an entity. Recreate the records you need when that happens.
:::

## Learn more

- [JSDoc tags](/reference/tags/): every tag a field can take.
- [HTTP query parameters](/reference/http/): the filter operators of each field type.
- [Errors](/reference/errors/): every error code and message.

## What's next

Group permissions into profiles and give organizations their modules: [Profiles and organizations](/tutorial/profiles-and-organizations/).
