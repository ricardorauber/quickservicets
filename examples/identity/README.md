# Identity example

An identity service built with QuickService: organizations, their users and teams, and the permissions that decide what each user may do. It is the finished project of the [tutorial](../../docs/src/content/docs/tutorial/index.md), which builds it step by step.

## The domain

- **Modules** are the parts of a product an organization can use, like `billing` or `reports`.
- **Permissions** pair a module with an action: `manage` or `view`. `manage` also grants `view`.
- **Profiles** bundle permissions under a slug, like `finance`.
- **Organizations** enable modules and have members.
- **Users** join organizations through **memberships**, which carry profiles.
- **Teams** group users inside an organization and carry profiles too.

A user's permissions in an organization are those of the profiles of their active membership there and of the active teams they belong to, counting only active modules of an active organization. `GET /users/<userId>/has-permissions` answers whether a user has a set of them.

| Entity | Fields |
| --- | --- |
| `Module` | `slug` (unique), `active` (defaults to `true`) |
| `Permission` | `module`, `action` (`manage` or `view`) |
| `Profile` | `slug` (unique), `permissions` |
| `Organization` | `slug` (unique), `legalName`, `name?`, `logo?`, `active`, `modules`, `members` |
| `Membership` | `organization`, `user`, `profiles`, `active` |
| `Team` | `organization`, `name`, `picture?`, `users`, `profiles`, `active` |
| `User` | `email` (unique), `name?`, `picture?`, `role` (`admin` or `basic`), `memberships`, `teams` |

The entities are in `entities/`, the permission check in `endpoints/users/[userId]/has-permissions/get.ts`, the migrations in `migrations/` and the tests in `tests/`.

## Run it

You need [Bun](https://bun.sh) and Docker. The QuickService packages are not on npm yet, so the example runs inside a clone of the repository. Install once, from the repository root:

```bash
bun install
cd examples/identity
```

### 1. Start PostgreSQL

```bash
docker run -d --name identity-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
```

### 2. Point the project at it

`.env.example` has the URL of that container. Copy it to `.env`, which Bun loads for every command:

```bash
cp .env.example .env
```

### 3. Create the tables

```bash
bun run migrate
```

```text
Applied 20261016211954_Initial
Applied 20261020133355_DataRules
```

### 4. Add the sample data

```bash
bun run seed
```

```text
modules: 3 created, 0 already there
permissions: 6 created, 0 already there
profiles: 3 created, 0 already there
organizations: 2 created, 0 already there
users: 3 created, 0 already there
memberships: 4 created, 0 already there
teams: 1 created, 0 already there
```

The seed (`scripts/seed.ts`) writes through the repositories, so every validation rule applies. Each record is looked up by its slug, email or other natural key first, so running it again creates nothing new (`0 created, 3 already there`...). The dataset:

| Records | Values |
| --- | --- |
| Modules | `organizations`, `billing`, `reports` |
| Permissions | `manage` and `view` for each module |
| Profiles | `admin` (manage everything), `finance` (`billing:manage`, `reports:view`), `viewer` (`organizations:view`, `reports:view`) |
| Organizations | `acme` (Acme Inc., all three modules), `globex` (Globex LLC, `organizations` and `reports`) |
| Users | `ana@acme.co` (admin), `bruno@acme.co`, `carla@globex.co` |
| Memberships | Ana in Acme as `admin` and in Globex as `viewer`, Bruno in Acme as `finance`, Carla in Globex as `viewer` |
| Teams | `Data` in Acme, with Ana and Bruno, as `viewer` |

### 5. Start the server

```bash
bun run dev
```

```text
quickservice listening on http://localhost:3000
```

The interactive API reference is at <http://localhost:3000/docs>, and the OpenAPI document at <http://localhost:3000/openapi.json>.

## Try it

`-g` stops curl from reading the brackets of `where[...]` as a pattern. Ids are shortened with `…` below; use the full ids from your own responses.

List the organizations:

```bash
curl -g "localhost:3000/organizations?fields=id,slug,name&sort=slug"
```

```json
{
  "data": [
    { "id": "01a1…4579", "slug": "acme", "name": "Acme" },
    { "id": "01a1…72e5", "slug": "globex", "name": "Globex" }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

Find Bruno, with the organizations of his memberships and his teams:

```bash
curl -g "localhost:3000/users?where[email][eq]=bruno@acme.co&populate=memberships.organization,teams&fields=id,email,memberships.organization.slug,teams.name"
```

```json
{
  "data": [
    {
      "id": "01a1…fecd",
      "email": "bruno@acme.co",
      "memberships": [{ "organization": { "slug": "acme" } }],
      "teams": [{ "name": "Data" }]
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### Check permissions

Ask whether Bruno may manage billing and view organizations in Acme. `billing:manage` comes from his membership's `finance` profile, and `organizations:view` from the `viewer` profile of the Data team:

```bash
curl "localhost:3000/users/<bruno-id>/has-permissions?organization=<acme-id>&rule=all&p=billing:manage&p=organizations:view"
```

```json
true
```

`rule=all` needs every permission, so adding one he lacks answers `false`:

```bash
curl "localhost:3000/users/<bruno-id>/has-permissions?organization=<acme-id>&rule=all&p=billing:manage&p=reports:manage"
```

```json
false
```

`rule=any` is satisfied by one of them:

```bash
curl "localhost:3000/users/<bruno-id>/has-permissions?organization=<acme-id>&rule=any&p=billing:manage&p=reports:manage"
```

```json
true
```

Leaving out the permissions fails with `400`:

```bash
curl "localhost:3000/users/<bruno-id>/has-permissions?organization=<acme-id>&rule=all"
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query",
    "details": [{ "field": "p", "message": "Is required" }]
  }
}
```

### Data rules

The entities reject what an identity service should. A slug that is taken answers `409`:

```bash
curl -X POST localhost:3000/organizations -d '{"slug":"acme","legalName":"Another Acme"}'
```

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Value already exists",
    "details": [{ "field": "slug", "message": "Value already exists" }]
  }
}
```

An email that is not one answers `400`:

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

## Run the tests

The tests build the project and send requests to the generated app in-process, on an in-memory database. They need neither the server nor PostgreSQL:

```bash
bun run test
```

```text
 102 pass
 1 skip
 0 fail
```

With `TEST_POSTGRES_URL` set, every API test also runs on PostgreSQL, in a new schema that the project's migrations create and that is dropped afterwards, and the migrations are applied one after the other. The migrations test replaces the `public` schema of that database, so give it a database of its own, not the one you seeded:

```bash
docker exec identity-pg createdb -U postgres identity_test
TEST_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/identity_test bun run test
```

```text
 204 pass
 0 fail
```

## Clean up

```bash
docker rm -f identity-pg
```
