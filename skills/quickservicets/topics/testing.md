# Testing

How to test a QuickService.ts project with `bun test` and `startTestService`, on the memory database and without opening a port.

`startTestService` from `@quickservicets/cli/testing` copies the project files you give it to a temporary folder, builds them, and starts the service in the test process on the memory database. You call it with `fetch` and read records with `repos`.

## Steps

1. Put tests in `tests/`, named `*.test.ts` (the `tsconfig.json` that `init` writes already includes `tests`).
2. Read the project's files and pass them to `startTestService`.
3. Call routes with `service.fetch(path, init)` and check the responses.
4. Always call `service.stop()` in `finally` or `afterAll`.
5. Run `bun test`.

```ts
// tests/tasks.test.ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const files = Object.fromEntries(
  [...new Bun.Glob("{entities,endpoints,hooks,jobs,features,lib}/**/*.ts").scanSync(root)]
    .concat("quickservicets.config.ts")
    .map((path) => [path, readFileSync(join(root, path), "utf8")]),
);

let service: TestService;
beforeAll(async () => {
  service = await startTestService({ files });
});
afterAll(() => service.stop());

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("creates and lists tasks", async () => {
  const created = await service.fetch("/tasks", json({ title: "Write tests" }));
  expect(created.status).toBe(201);
  const list = await (await service.fetch("/tasks")).json();
  expect(list.total).toBe(1);
});

test("rejects an empty title", async () => {
  const response = await service.fetch("/tasks", json({ title: "" }));
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
});

test("reads records through the repositories", async () => {
  expect(await service.repos.tasks.any((t) => t.title.eq("Write tests"))).toBe(true);
});
```

- `startTestService({ files, env })` takes the files by project-relative path and the environment, like `{ STRIPE_KEY: "sk_test", QS_QUEUES_ENABLED: "true" }`. The service sees only the variables in `env`, not `.env`, so pass every variable the config requires.
- It always uses the memory database, whatever the config says, so tests need no migrations and no database server.
- Each call starts a fresh service with an empty database; start one per test file, or per test when tests must not share records.
- `service.fetch("/tasks?limit=5", init)` takes a path, not a full URL.
- `stop()` runs the shutdown sequence, removes the temporary folder and fails when a feature left a timer running.

Check error responses by `error.code` and `error.details[].field`, not by message text. Run one test with `bun test -t "creates"`.

Full docs: [Testing your API in-process](/recipes/testing/) and [Project features](/guides/project-features/#testing-a-feature).

## Do not

- Do not start `bun run dev` or open a port to test routes; use `startTestService`.
- Do not point tests at a real database; `startTestService` uses the memory database.
- Do not forget `service.stop()`; the temporary folder and timers would stay.
- Do not pass `.generated/` files; the service builds them itself.
- Do not assert on full error messages when the code and field are enough.
