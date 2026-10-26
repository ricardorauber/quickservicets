---
title: Users, memberships and teams
description: Pair fields of two entities into one relation and read it from both sides.
sidebar:
  order: 4
---

Users join organizations through memberships, and teams group users inside an organization. Here the model gets its last three entities, and you meet **relations**: two fields, one on each entity, that describe the same link and stay in sync.

<details>
<summary>The entities so far</summary>

```ts check title="entities/Module.ts"
export enum ModuleAction {
    manage,
    view
}

export type Module = {
    /** @unique @minLength 2 @maxLength 64 */
    slug: string
    /** @default true */
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

```ts check title="entities/Profile.ts"
import { Permission } from "./Permission"

export type Profile = {
    /** @unique @minLength 2 @maxLength 64 */
    slug: string
    permissions: Permission[]
}
```

</details>

## The User entity

Create `entities/User.ts`:

```ts check title="entities/User.ts"
import type { Media } from "@quickservicets/core"
import { Membership } from "./Membership"
import { Team } from "./Team"

export enum UserRole {
    admin,
    basic
}

export type User = {
    /** @unique @format email @maxLength 254 */
    email: string
    /** @minLength 1 @maxLength 120 */
    name?: string
    /** @accept image/png,image/jpeg,image/webp @maxSize 1MB */
    picture?: Media

    /** @default UserRole.basic */
    role: UserRole

    memberships: Membership[]
    teams: Team[]
}
```

- `email` is `@unique`, so two users cannot share one; `@format email` rejects anything that is not an email address (`Must be a valid email`), and `@maxLength 254` is the longest an address can be.
- `name?` takes 1 to 120 characters when it is set.
- `picture?` accepts PNG, JPEG and WebP images of at most 1 MB, like the organization's logo.
- `role` is required, but `@default UserRole.basic` fills it in when a create body leaves it out. `@default` takes a member of the field's own enum, or the value itself (`@default 'basic'`).
- `memberships` and `teams` are reference arrays. Like every non-optional reference array, they default to `[]` when you leave them out.

## The Membership entity

Create `entities/Membership.ts`:

```ts check title="entities/Membership.ts"
import { Profile } from "./Profile"
import { Organization } from "./Organization"
import { User } from "./User"

export type Membership = {
    organization: Organization
    user: User
    profiles: Profile[]
    /** @default true */
    active: boolean
}
```

`active` defaults to `true`, so a new membership is active unless the body says otherwise.

## The Team entity

Create `entities/Team.ts`:

```ts check title="entities/Team.ts"
import { Media } from "@quickservicets/core"
import { Organization } from "./Organization"
import { Profile } from "./Profile"
import { User } from "./User"

export type Team = {
    organization: Organization
    /** @minLength 1 @maxLength 120 */
    name: string
    /** @accept image/png,image/jpeg,image/webp @maxSize 1MB */
    picture?: Media
    users: User[]
    profiles: Profile[]
    /** @default true */
    active: boolean
}
```

The team's `name` takes 1 to 120 characters, its `picture?` follows the same image rules as the user's, and `active` defaults to `true`.

## Members of an organization

Finally, give `Organization` its `members`. This is the finished `entities/Organization.ts`:

```ts check title="entities/Organization.ts"
import type { Media } from "@quickservicets/core"
import { Membership } from "./Membership"
import { Module } from "./Module"

export type Organization = {
    /** @unique @minLength 2 @maxLength 64 */
    slug: string
    /** @minLength 1 @maxLength 200 */
    legalName: string
    /** @minLength 1 @maxLength 120 */
    name?: string
    /** @accept image/png,image/jpeg,image/webp @maxSize 1MB */
    logo?: Media;
    /** @default true */
    active: boolean
    modules: Module[]
    members: Membership[]
}
```

Your `entities/` folder now matches `examples/identity/entities`.

## How fields pair into relations

When entity A has exactly one field pointing at entity B, and B has exactly one field pointing back at A, QuickService.ts pairs the two fields into one relation. The kind depends on the two sides:

| Fields | Kind | Stored as | Derived side |
| --- | --- | --- | --- |
| `Membership.user` and `User.memberships` | 1-N | the `user` column of `memberships` | `User.memberships` |
| `Membership.organization` and `Organization.members` | 1-N | the `organization` column of `memberships` | `Organization.members` |
| `Team.users` and `User.teams` | N-N | one junction table, `teams__users` | neither: both read the same table |

- A **1-N** relation is stored once, as the foreign key on the single side. The array side is **derived**: it has no column and is computed when you read it, ordered by the related records' `createdAt`.
- An **N-N** relation is stored in one junction table, so a change from either side shows up on both.

The other references stay one-way. `Team.organization` has no partner, because `Organization` has no field pointing at `Team`. `Membership.profiles` and `Team.profiles` have none either.

:::tip
When both entities have more than one field pointing at the other, the build fails and asks you to pair them with `@inverse <field>`. `@inverse none` keeps a field out of any relation.
:::

## Try it

Create a user. `role` gets its default, and both arrays start empty:

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@acme.co","name":"Ana"}'
```

```json
{
  "email": "ana@acme.co",
  "name": "Ana",
  "role": "basic",
  "id": "01a1…1ba1",
  "createdAt": "2026-10-16T22:25:20.851Z",
  "updatedAt": "2026-10-16T22:25:20.851Z",
  "picture": null,
  "memberships": [],
  "teams": []
}
```

An email that is already taken fails with `409 Value already exists`, and one that is not an email fails with `400`:

```bash
curl -X POST localhost:3000/users -d '{"email":"abc"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "email", "message": "Must be a valid email" }]
  }
}
```

A role outside the enum fails too:

```bash
curl -X POST localhost:3000/users -d '{"email":"x@acme.co","role":"owner"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "role", "message": "Must be one of: admin, basic" }]
  }
}
```

### A membership shows up on both sides

The dev server restarted when you added the entities, so first recreate a `billing` module, a `manage` permission for it, the `finance` profile and the `acme` organization, as on the previous pages. Then add Ana to Acme:

```bash
curl -X POST localhost:3000/memberships \
  -d '{"organization":"<acme-id>","user":"<ana-id>","profiles":["<finance-id>"],"active":true}'
```

```json
{
  "organization": "01a1…5773",
  "user": "01a1…1ba1",
  "profiles": ["01a1…4594"],
  "active": true,
  "id": "01a1…f7cb",
  "createdAt": "2026-10-16T22:25:20.852Z",
  "updatedAt": "2026-10-16T22:25:20.852Z"
}
```

You only wrote the membership, yet the user now lists it:

```bash
curl localhost:3000/users/<ana-id>
```

```json
{
  "id": "01a1…1ba1",
  "createdAt": "2026-10-16T22:25:20.851Z",
  "updatedAt": "2026-10-16T22:25:20.851Z",
  "email": "ana@acme.co",
  "name": "Ana",
  "picture": null,
  "role": "basic",
  "memberships": ["01a1…f7cb"],
  "teams": []
}
```

And so does the organization:

```bash
curl "localhost:3000/organizations/<acme-id>?fields=slug,members"
```

```json
{ "slug": "acme", "members": ["01a1…f7cb"] }
```

### Teams from either side

Create a team with Ana in it:

```bash
curl -X POST localhost:3000/teams \
  -d '{"organization":"<acme-id>","name":"Finance","users":["<ana-id>"],"profiles":["<finance-id>"],"active":true}'
```

```json
{
  "organization": "01a1…5773",
  "name": "Finance",
  "profiles": ["01a1…4594"],
  "active": true,
  "id": "01a1…535f",
  "createdAt": "2026-10-16T22:25:20.852Z",
  "updatedAt": "2026-10-16T22:25:20.852Z",
  "picture": null,
  "users": ["01a1…1ba1"]
}
```

```bash
curl "localhost:3000/users/<ana-id>?fields=email,teams"
```

```json
{ "email": "ana@acme.co", "teams": ["01a1…535f"] }
```

Now remove her from the team, writing the user's side this time:

```bash
curl -X PATCH localhost:3000/users/<ana-id> -d '{"teams":{"remove":["<team-id>"]}}'
```

```json
{
  "email": "ana@acme.co",
  "name": "Ana",
  "role": "basic",
  "id": "01a1…1ba1",
  "createdAt": "2026-10-16T22:25:20.851Z",
  "updatedAt": "2026-10-16T22:25:20.854Z",
  "picture": null,
  "memberships": ["01a1…f7cb"],
  "teams": []
}
```

The team sees the change right away:

```bash
curl "localhost:3000/teams/<team-id>?fields=name,users"
```

```json
{ "name": "Finance", "users": [] }
```

### Populate through a derived side

Derived sides work like stored fields in `populate`, `fields` and filters:

```bash
curl "localhost:3000/users/<ana-id>?populate=memberships.organization&fields=email,memberships.organization.slug"
```

```json
{ "email": "ana@acme.co", "memberships": [{ "organization": { "slug": "acme" } }] }
```

### Required links protect themselves

`Membership.user` is required, so you cannot detach a membership from its user by writing the user's side:

```bash
curl -X PATCH localhost:3000/users/<ana-id> -d '{"memberships":[]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "memberships", "message": "Cannot unlink: user is required" }]
  }
}
```

For the same reason, a user who still has memberships cannot be deleted:

```bash
curl -X DELETE localhost:3000/users/<ana-id>
```

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by memberships"
  }
}
```

## Learn more

- [JSDoc tags](/reference/tags/): `@default`, `@inverse`, `@owner`, `@joinTable` and `@onDelete`.
- [HTTP query parameters](/reference/http/): `populate`, `fields` and filters on reference arrays.
- [Errors](/reference/errors/): `Cannot delete` and the other messages.

## What's next

Store all of this in a real database: [Migrations and PostgreSQL](/tutorial/migrations-and-postgres/).
