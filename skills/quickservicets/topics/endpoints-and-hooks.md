# Endpoints and hooks

How to add custom routes in `endpoints/`, share request logic with hooks in `hooks/`, and query records with the repositories.

## Endpoints

1. Create a file whose folders are the path and whose name is the method: `get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts` or `options.ts`.
2. A folder in brackets is a path parameter: `endpoints/tasks/[id]/complete/post.ts` serves `POST /tasks/:id/complete`.
3. Default-export a handler typed `Endpoint<Body, Result>`.
4. Run `bun run build` (or keep `bun run dev` running).

```ts
// endpoints/tasks/[id]/complete/post.ts
import { HttpError, type Endpoint } from "@quickservicets/core";

/**
 * @summary Completes a task
 * @status 200
 */
const handler: Endpoint<unknown, { id: string; done: boolean }> = async (repos, req) => {
  const task = await repos.tasks.findById(req.params.id!);
  if (!task) throw new HttpError(404, "Task not found");
  const updated = await repos.tasks.update(task.id, { done: true });
  return { id: updated.id, done: updated.done };
};

export default handler;
```

- `req.params`, `req.query` (`URLSearchParams`), `req.headers`, `await req.json()`, `req.context` (shared with hooks), `req.id`.
- Return a value for JSON (200), `undefined` for 204, or a `Response`. `res.status(code)` and `res.header(name, value)` change one response.
- Throw `HttpError(status, message, { details })` for error responses; the code comes from the status.
- A file with the same method and path as a generated route replaces it, like `endpoints/tasks/post.ts`.

## Hooks

A hook runs before (`definePreHook`) or after (`definePostHook`) a route. The file name is the tag:

```ts
// hooks/authorized.ts
import { definePreHook, HttpError } from "@quickservicets/core";

export default definePreHook(async (_repos, req, _res, args) => {
  const token = req.headers.get("authorization");
  if (!token) throw new HttpError(401, "Authentication required");
  if (args.length > 0 && !args.includes("admin")) throw new HttpError(403, "Forbidden");
});
```

Attach it with a JSDoc tag:

- On an entity, for all its generated routes: `/** @authorized */` above the type, or only some: `/** @authorized:create,update,delete admin */`.
- On an endpoint: `@authorized` in the handler's JSDoc comment.

`definePostHook((data, repos, req, res, args) => newData)` receives the response body and returns the body to send.

## Repository queries

```ts
const open = await repos.tasks.where((t) => t.done.eq(false)).orderBy((t) => t.dueAt).take(20).toArray();
const first = await repos.tasks.where((t) => t.title.contains("docs")).firstOrDefault();
const late = await repos.tasks.count((t) => t.dueAt.lt(new Date()));
const anyOpen = await repos.tasks.any((t) => t.done.eq(false));
const allDone = await repos.tasks.all((t) => t.done.eq(true));
const noneLate = await repos.tasks.none((t) => t.dueAt.lt(new Date()).and(t.done.eq(false)));
const notDone = await repos.tasks.where((t) => t.done.eq(true).not()).toArray();
```

- Records: `create`, `findById`, `findOne`, `list`, `update`, `replace`, `delete`.
- Fluent queries: `where`, `orderBy`, `thenBy`, `skip`, `take`, `select`, `include`, then `toArray()`, `first()`, `firstOrDefault()`, `count()`, `page()`.
- `any(condition?)`, `all(condition)` and `none(condition?)` answer `true` or `false`, on a query or directly on a repository.
- `.not()` negates any condition; `and` and `or` combine them.
- `repos.transaction(async () => { ... })` runs every repository call inside it in one transaction.

## Jobs

```ts
// jobs/close-late-tasks.ts
import { job } from "@quickservicets/core";

export default job("0 3 * * *", async ({ repos }) => {
  const late = await repos.tasks.where((t) => t.dueAt.lt(new Date())).toArray();
  return { late: late.length };
});
```

Run one now with `bun run quickservicets job run close-late-tasks`; list them with `bun run quickservicets job list`.

Full docs: [Custom endpoints](/guides/endpoints/), [Hooks](/guides/hooks/) and [Fluent queries](/guides/queries/).

## Do not

- Do not call `.all()` without a condition to read records; use `.toArray()`.
- Do not register routes in code; a file in `endpoints/` is the route.
- Do not name hook files in PascalCase or after a built-in tag; hook names match `^[a-z][a-zA-Z0-9]*$`.
- Do not tag an entity with a hook that has no file in `hooks/`; the build fails with `unknown tag`.
- Do not import from `.generated/` in endpoints for repository types; `repos` is already typed.
- Do not build SQL strings; use the repositories.
