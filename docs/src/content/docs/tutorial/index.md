---
title: Tutorial overview
description: What the tutorial builds, its data model and what you need before you start.
sidebar:
  order: 1
---

In this tutorial you build an identity service, step by step: users who belong to organizations, teams inside those organizations, and permissions that decide what each user may do. The finished project is the `examples/identity` folder of the quickservice repository, so you can compare your files with it at any time.

## What you build

- **Modules** are the parts of your product an organization can use, like `billing` or `reports`.
- **Permissions** pair a module with an action: `manage` or `view`.
- **Profiles** bundle permissions under a name, like `finance`.
- **Organizations** enable modules and have members.
- **Users** join organizations through **memberships**, which carry profiles.
- **Teams** group users inside an organization and carry profiles too.

The first part of the tutorial (these pages) builds the model and runs it on PostgreSQL. The second part adds a custom endpoint that answers "does this user have these permissions?", explores the API docs and writes tests.

## The data model

Every entity also gets `id`, `createdAt` and `updatedAt` automatically.

| Entity | Fields | Points to |
| --- | --- | --- |
| `Module` | `slug`, `active` | — |
| `Permission` | `module`, `action` (`manage` or `view`) | one `Module` |
| `Profile` | `slug`, `permissions` | many `Permission` |
| `Organization` | `slug`, `legalName`, `name?`, `logo?`, `active`, `modules`, `members` | many `Module`, many `Membership` |
| `Membership` | `organization`, `user`, `profiles`, `active` | one `Organization`, one `User`, many `Profile` |
| `Team` | `organization`, `name`, `picture?`, `users`, `profiles`, `active` | one `Organization`, many `User`, many `Profile` |
| `User` | `email`, `name?`, `picture?`, `role` (`admin` or `basic`), `memberships`, `teams` | many `Membership`, many `Team` |

Three pairs of fields describe the same relation from both sides, and quickservice keeps both sides in sync:

- `Membership.user` and `User.memberships`: each membership has one user, and a user has many memberships (1-N).
- `Membership.organization` and `Organization.members`: each membership has one organization, and an organization has many members (1-N).
- `Team.users` and `User.teams`: a team has many users, and a user is in many teams (N-N).

## Before you start

- A recent version of [Bun](https://bun.sh).
- A clone of the quickservice repository. The packages are not on npm yet, so your project lives inside the repository, under `examples/`.
- The [Getting started](/getting-started/) page, if you have not read it yet.
- Docker, or any PostgreSQL server, for the last page of this part.

## Create the project

From the root of the repository, create a project that keeps its data in memory. It needs no database server, which makes it quick to experiment with; you move it to PostgreSQL at the end of this part.

```bash
bun packages/cli/src/index.ts init examples/my-identity --db memory
cd examples/my-identity
bun run dev
```

Inside the repository, `init` links the workspace packages and installs them for you. The dev server listens on `http://localhost:3000` and restarts whenever an entity changes. The [CLI reference](/reference/cli/) lists every command.

:::note
`examples/identity` already holds the finished project, so pick another folder name, like `examples/my-identity`.
:::

## What's next

Start with the first two entities: [Modules and permissions](/tutorial/modules-and-permissions/).
