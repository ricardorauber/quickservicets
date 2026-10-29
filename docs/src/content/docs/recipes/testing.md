---
title: Testing your API in-process
description: Test generated routes and custom endpoints with bun test, on an in-memory database, without starting a server.
sidebar:
  order: 21
---

You want fast, reliable tests for your API: real routes, real validation, real hooks, but no port to open, no database to start and no data left behind. The trick is to build the project once, then assemble the app yourself in the test with `createApp` and an in-memory database, and send it `Request` objects through `server.fetch`.

## The project

Any project works. This recipe uses one entity:

```ts check title="entities/Book.ts"
export type Book = {
  /** @minLength 1 */
  title: string;
  /** @unique */
  isbn: string;
  /** @min 1 */
  pages?: number;
};
```

Add a `test` script to `package.json` that builds before testing, so the tests always run against the current entities, endpoints and hooks:

```json
{
  "scripts": {
    "test": "quickservicets build && bun test"
  }
}
```

## The test file

`tests/books.test.ts`:

```ts check title="tests/books.test.ts"
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, resolveConfig, type Server } from "@quickservicets/core";
import { models } from "../.generated/models.ts";
import { crudRoutes, endpoints, hooks } from "../.generated/routes.ts";

type Json = Record<string, any>;
type Result = { status: number; body: Json; headers: Headers };

let server: Server;

beforeAll(async () => {
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig(
    {
      database,
      storage: { default: localStorage({ dir: mkdtempSync(join(tmpdir(), "uploads-")) }) },
      logger: { info() {}, warn() {}, error() {} },
    },
    {},
  );
  server = createApp({ models, crudRoutes, endpoints, hooks, config }).server;
});

/** Sends a request to the app in-process and parses the JSON response. */
async function call(method: string, path: string, body?: unknown): Promise<Result> {
  const request = new Request(`http://test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await server.fetch(request);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

/** Creates a record through the API, failing the test when the response is not 201. */
async function create(path: string, body: Json): Promise<Json> {
  const result = await call("POST", path, body);
  if (result.status !== 201) throw new Error(`POST ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

describe("books", () => {
  test("creates and reads a book", async () => {
    const created = await call("POST", "/books", { title: "Dune", isbn: unique("isbn"), pages: 412 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Dune", pages: 412 });

    const read = await call("GET", `/books/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe("Dune");
  });

  test("rejects an invalid body with details per field", async () => {
    const result = await call("POST", "/books", { title: "", pages: 0 });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("VALIDATION_ERROR");
    expect(result.body.error.details).toEqual([
      { field: "title", message: "Must be at least 1 characters" },
      { field: "isbn", message: "Is required" },
      { field: "pages", message: "Must be at least 1" },
    ]);
  });

  test("rejects a duplicate isbn", async () => {
    const book = await create("/books", { title: "Emma", isbn: unique("isbn") });
    const result = await call("POST", "/books", { title: "Emma again", isbn: book.isbn });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("CONFLICT");
    expect(result.body.error.details).toEqual([{ field: "isbn", message: "Value already exists" }]);
  });

  test("filters the list", async () => {
    const book = await create("/books", { title: "Ulysses", isbn: unique("isbn") });
    const result = await call("GET", `/books?where[isbn][eq]=${book.isbn}`);
    expect(result.status).toBe(200);
    expect(result.body.total).toBe(1);
    expect(result.body.data[0].id).toBe(book.id);
  });

  test("updates and deletes", async () => {
    const book = await create("/books", { title: "Draft", isbn: unique("isbn") });
    const updated = await call("PATCH", `/books/${book.id}`, { title: "Final" });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe("Final");

    expect((await call("DELETE", `/books/${book.id}`)).status).toBe(204);
    const gone = await call("GET", `/books/${book.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe("NOT_FOUND");
  });
});
```

What each part does:

- **`.generated/models.ts` and `.generated/routes.ts`** are what `quickservicets build` writes: the entity models, the generated CRUD routes with their hooks, your custom endpoints and the hook definitions. Importing them gives the test exactly the app that `bun run dev` serves.
- **`memoryAdapter()`** keeps records in the test process, so there is nothing to migrate and every run starts empty. `connect(models)` prepares it, as the server does at startup.
- **`resolveConfig(config, {})`** fills in every default. The second argument is the environment; passing `{}` keeps variables from your shell, like `DATABASE_SCHEMA`, `PORT` or `NODE_ENV`, out of the tests.
- **`localStorage` in a temporary folder** keeps uploads out of the project's `uploads/` folder once the project has file entities. Without it, the default storage writes there.
- **The silent `logger`** drops the JSON line that each request logs by default.
- **`call`** builds a `Request` and passes it to `server.fetch`, the same function `Bun.serve` calls. The host in the URL is never used.
- **`create`** seeds records through the API and fails loudly when that does not work, so a broken setup never looks like a broken assertion. **`unique`** keeps `@unique` values apart, since the records of every test share one database.

<details>
<summary>What the two generated files export</summary>

The build writes the full models and routes; these are the exports the test uses:

```ts check title=".generated/models.ts"
import type { EntityModel } from "@quickservicets/core";

export declare const models: EntityModel[];
```

```ts check title=".generated/routes.ts"
import type { AppEndpoint, CrudRouteEntry, HookDefinition } from "@quickservicets/core";

export declare const crudRoutes: CrudRouteEntry[];
export declare const endpoints: AppEndpoint[];
export declare const hooks: Map<string, HookDefinition>;
```

</details>

## Run it

```bash
bun run test
```

```
$ quickservicets build && bun test
Built 1 entity, 0 custom endpoints and 0 hooks.
bun test v1.4.2

 6 pass
 0 fail
 19 expect() calls
Ran 6 tests across 2 files.
```

The one entity is `Book`: the built-in `File` and `Media` are built only when an entity references them or the config sets `storage`. The six tests are the five above plus the one in [A fresh database for every test](#a-fresh-database-for-every-test). If you already built, `bun test` alone runs the tests against the last build, and `bun test -t duplicate` runs only the tests whose name matches.

## What the responses look like

The assertions above check these bodies, which are the same ones a client gets over HTTP:

```
POST /books {"title":"","pages":0}
→ 400 {"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"title","message":"Must be at least 1 characters"},{"field":"isbn","message":"Is required"},{"field":"pages","message":"Must be at least 1"}]}}

POST /books {"title":"Dune","isbn":"978-0441172719"}   (the isbn exists)
→ 409 {"error":{"code":"CONFLICT","message":"Value already exists","details":[{"field":"isbn","message":"Value already exists"}]}}

GET /books?where[isbn][eq]=978-0441172719
→ 200 {"data":[{"id":"01a146d1-…","createdAt":"…","updatedAt":"…","title":"Dune","isbn":"978-0441172719","pages":412}],"total":1,"limit":20,"offset":0}

GET /books/01a10000-0000-7000-8000-000000000000
→ 404 {"error":{"code":"NOT_FOUND","message":"Book not found"}}

DELETE /books/<id>
→ 204 (no body)
```

Check `body.error.code` and `body.error.details` rather than `message` when you can: the code depends only on the status, and each detail names the field. The [Errors reference](/reference/errors/) lists every code and message.

## Variations

### A fresh database for every test

When tests must not see each other's records, build the app in `beforeEach` instead of `beforeAll`. The memory adapter is cheap to create:

```ts check title="tests/fresh.test.ts"
import { beforeEach, expect, test } from "bun:test";
import { createApp, memoryAdapter, resolveConfig, type Server } from "@quickservicets/core";
import { models } from "../.generated/models.ts";
import { crudRoutes, endpoints, hooks } from "../.generated/routes.ts";

let server: Server;

beforeEach(async () => {
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {});
  server = createApp({ models, crudRoutes, endpoints, hooks, config }).server;
});

test("starts empty", async () => {
  const response = await server.fetch(new Request("http://test/books"));
  expect(await response.json()).toEqual({ data: [], total: 0, limit: 20, offset: 0 });
});
```

### Headers and file uploads

Hooks often read headers, and file fields take `multipart/form-data`. Let `call` accept headers and a `FormData` body; leave out the `content-type` for `FormData`, so the boundary is set for you:

```ts check title="tests/call.ts"
import type { Server } from "@quickservicets/core";

declare const server: Server;

export async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json", ...headers };
  }
  const response = await server.fetch(new Request(`http://test${path}`, init));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

// await call("GET", "/books", undefined, { authorization: "Bearer test-token" });
// const form = new FormData();
// form.append("file", new File([new Uint8Array(8)], "pic.png", { type: "image/png" }));
// await call("POST", "/media", form);
```

### Custom endpoints and hooks

Nothing changes: `endpoints` and `hooks` from `.generated/routes.ts` already contain them, so `call` reaches a custom endpoint, and the hooks of every route run, exactly as in the dev server. Test a hook through the routes it guards, sending the headers it reads.

## Related

- [Repository API](/reference/api/), for the `repos` your endpoints and hooks receive
- [Configuration](/reference/config/), for the keys `resolveConfig` fills in
- [CLI: `build`](/reference/cli/#build)
- [HTTP reference](/reference/http/), for list filters
- [Errors](/reference/errors/)

Previous: [Multi-tenant schemas](/recipes/multi-tenant/). Next: [Scheduled cleanup](/recipes/scheduled-cleanup/).
