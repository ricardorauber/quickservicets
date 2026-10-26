---
title: API docs
description: The generated OpenAPI document and the Scalar page that renders it.
sidebar:
  order: 42
---

Every build writes an OpenAPI 3.1 document of your API, and the server shows it as an interactive page. You do not write any of it: entities, custom endpoints, hooks, query items and files are documented from the code.

## The OpenAPI document

`quickservicets build` (and so `dev`) writes the document to `.generated/openapi.json`. Its `info.title` and `info.version` come from the project's `package.json`. The same input always gives the same document, so you can commit it or diff it in CI to review API changes.

The server also serves it:

```bash
curl localhost:3000/openapi.json
```

```json
// 200 OK (content-type: application/json), shortened
{"openapi":"3.1.0","info":{"title":"docs-check-0087","version":"0.0.0"},"tags":[{"name":"documents"},{"name":"files"},{"name":"media"},{"name":"organizations"}],"paths":{"/documents":{"get":{"tags":["documents"],"operationId":"listDocument", ...
```

Use it to generate clients, import it into Postman or Insomnia, or feed it to any OpenAPI tool.

## `/docs` with Scalar

Open `http://localhost:3000/docs` in a browser for a page that renders the document with [Scalar](https://scalar.com): every route with its parameters, bodies and responses, and a client to try requests. The page loads `@scalar/api-reference` from jsDelivr at a pinned version and points it at `/openapi.json`:

```bash
curl -i localhost:3000/docs
```

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
x-request-id: 01a146d1-f02d-743b-87f6-924220b5f947
Content-Length: 374

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>docs-check-0087 API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.3"></script>
  </body>
</html>
```

`/docs` and `/openapi.json` run no hooks and are not listed in the document. Both paths are reserved: an entity whose route uses `/docs`, or a custom endpoint for `GET /docs` or `GET /openapi.json`, fails the build.

## Turning the docs off

`docs.enabled` decides whether the two routes exist. It defaults to `true`, except in production (`NODE_ENV=production` or `production: true`), where it defaults to `false`:

```ts check title="quickservicets.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  docs: { enabled: true },
});
```

When they are off, both paths answer like any unknown route:

```bash
NODE_ENV=production bun .generated/server.ts
curl localhost:3000/docs
```

```json
// 404 Not Found
{"error":{"code":"NOT_FOUND","message":"Route not found"}}
```

`.generated/openapi.json` is written either way.

## What is documented

### Entities

Each entity gets four schemas under `components.schemas`:

| Schema | Used for |
| --- | --- |
| `User` | Responses: system fields and every field that is not `@hidden`. |
| `UserCreate` | `POST` bodies; required fields without `@default` are required. |
| `UserReplace` | `PUT` bodies; every required field is required. |
| `UserUpdate` | `PATCH` bodies; nothing is required. |

Field schemas follow the tags: types, formats (`date-time`, `uuid`, `email`, `uri`), enums (a named enum is one shared schema), defaults, lengths, item counts and number ranges. When `@fields` or `@exclude` narrow what `list` or `read` return, the document adds `UserListItem` or `UserRead` with only those paths. A shared `Error` schema describes every error response.

Each generated route is an operation tagged with the entity's collection (or `<schema>/<collection>`), with an `operationId` such as `listUser`, `readUser` or `createUser`. List operations document `limit`, `offset`, `sort`, `where` (with the filterable fields and their operators), `fields`, `exclude` and `populate`; read operations document `fields`, `exclude` and `populate`. The `populate` description lists the paths allowed up to `populate.maxDepth`, and reference fields in responses are typed as either the id or the referenced record. Error responses are listed where they can happen: 400, 404, and 409 for unique fields and referenced entities.

### Custom endpoints

A custom endpoint's `@summary` and `@description` become the operation's. When its default export is typed `Endpoint<Body, Result>`, the body and result types become the request and response schemas (entity types become `$ref`s); on `GET` and `DELETE` the first type is the query instead, and each typed query item becomes a query parameter with its tags:

```ts check title="endpoints/health/get.ts"
import type { Endpoint } from "@quickservicets/core";

type HealthQuery = {
  /** @default false */
  verbose?: boolean;
};

type Health = { status: "ok"; uptimeSeconds?: number };

/**
 * @summary Health check
 * @description Reports that the service is up; `verbose=true` adds the uptime.
 */
const handler: Endpoint<HealthQuery, Health> = (repos, req) => {
  if (!req.queryItems.verbose) return { status: "ok" };
  return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
};

export default handler;
```

The build documents it as:

```json
{"tags":["health"],"operationId":"getHealth","parameters":[{"name":"verbose","in":"query","required":false,"schema":{"type":"boolean","default":false}}],"responses":{"200":{"description":"Success","content":{"application/json":{"schema":{"type":"object","properties":{"status":{"type":"string","enum":["ok"]},"uptimeSeconds":{"type":"number"}},"required":["status"]}}}}},"summary":"Health check","description":"Reports that the service is up; `verbose=true` adds the uptime."}
```

Without generics, bodies and responses are documented as `{ "type": "object" }`. A type the build cannot convert is documented the same way, with a warning naming the file. An endpoint that overrides a generated route without generics keeps the generated operation's documentation.

### Hooks

Each operation lists the hooks that run on it: a `Hooks: <name>(<args>)` line in its description and an `x-hooks` extension. A hook can also declare the responses it adds and that it expects a bearer token:

```ts check title="hooks/authorized.ts"
import { definePreHook, HttpError } from "@quickservicets/core";

export default definePreHook(
  (repos, req) => {
    if (!req.headers.get("authorization")?.startsWith("Bearer ")) throw new HttpError(401, "Missing token");
  },
  { docs: { responses: [401], security: "bearer" } },
);
```

With `/** @authorized */` on `User`, `GET /users/{id}` is documented with:

```json
{"description":"Hooks: authorized","x-hooks":[{"name":"authorized","phase":"pre","args":[]}],"security":[{"bearerAuth":[]}],"responses":{"200":{},"401":{},"404":{}}}
```

(trimmed), and `components.securitySchemes` defines `bearerAuth` (`type: http`, `scheme: bearer`) once, so Scalar shows a field for the token.

### Files

- `POST` and `PUT` of a file entity document a `multipart/form-data` body with a required binary `file` and the entity's own fields, plus the 413 and 415 responses.
- `POST`, `PUT` and `PATCH` of an entity with file fields document both a JSON body and a multipart body, where each file field is binary (an array of binary items for arrays), with `@maxSize`, `@accept` and the other limits in its description.
- In `proxy` and `signed` modes, `GET /<route>/{id}/file` is documented with a binary response; in `signed` mode also with the `expires` and `signature` parameters and the 403 response.

See [Files and storage](/guides/files/) for how these routes behave.

## See also

- [Configuration](/reference/config/): `docs.enabled`, `production` and `populate.maxDepth`.
- [Tags](/reference/tags/): `@summary`, `@description` and the tags reflected in schemas.
- [HTTP query parameters](/reference/http/): the parameters of the generated routes.

Next: [Configuration and logging](/guides/configuration/).
