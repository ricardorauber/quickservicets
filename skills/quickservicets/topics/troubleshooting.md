# Troubleshooting

The ten most common QuickService.ts errors, with the exact message and the fix for each.

## 1. `no such table: tasks` (or `relation "tasks" does not exist`)

A request answers 500 because the table was never created. Create and apply the migration:

```bash
bun run build
bun run quickservicets migration add CreateTasks
bun run quickservicets migrate
```

## 2. `Warning: Model has changes without a migration. Run "quickservicets migration add <Name>"`

`bun run build` found entity changes that no migration covers. Run `bun run quickservicets migration add <Name>` and then `bun run quickservicets migrate`.

## 3. `.generated/models.ts is missing; run "quickservicets build" first`

A command that needs the model ran before any build. Run `bun run build`, then the command again.

## 4. `Directory is not empty`

`quickservicets init` only writes into an empty or new folder. Pick a new name: `bunx quickservicets init my-api --db sqlite`.

## 5. `entities/post.ts: entity file names must be PascalCase (e.g. User.ts)`

Rename the file to PascalCase and export a type with the same name: `entities/Post.ts` exports `Post`. The related message `exported type Article must be named Post` has the same fix.

## 6. `entities/Post.ts: field "id" is a system field added to every entity and cannot be declared`

Remove `id`, `createdAt` and `updatedAt` from the type; every entity gets them.

## 7. `entities/Post.ts: unknown tag @authorize: no hook or feature defines it`

The tag names no hook and no native. Fix the spelling, or create `hooks/authorize.ts` that default-exports `definePreHook(...)`. When the message is `@history needs history, which is not enabled; add history: {} to quickservicets.config.ts`, add that key to the config, rebuild and create a migration.

## 8. `Invalid environment:` followed by `DATABASE_URL is required (url)`

A variable declared under `env` in the config is missing or invalid. Set it in `.env` or in the host's environment, and check with `bun run quickservicets env check`.

## 9. `Invalid QS_SERVER_PORT (server.port): expected an integer between 1 and 65535, got "abc"`

A `QS_*` variable has a value its key does not accept. Fix or unset the variable. `Unknown environment variable <name> (did you mean <closest name>?)` is only a warning: rename the variable to the name it suggests.

## 10. `Query on Task matched more than repositories.toArrayMax (10000) records`

`toArray()` refuses to load more than `repositories.toArrayMax` records. Page with `.skip(n).take(m)` or `.page(...)`, narrow the `where`, or raise `repositories.toArrayMax` in the config.

## Exit codes and `--json`

Every command exits with 0 on success, 1 when the operation fails, 2 for a usage error or a question it cannot ask (`<command> needs <flag> when not interactive`: pass that flag), 3 for a configuration error and 4 when the database cannot be reached. With `--json`, the same failure is one document on stdout, like `{"ok":false,"error":{"code":"DATABASE_UNREACHABLE","message":"Failed to connect"}}`; read `error.code` (`FAILED`, `USAGE_ERROR`, `NOT_INTERACTIVE`, `CONFIG_ERROR`, `DATABASE_UNREACHABLE`) instead of parsing text. Pass `--yes` in scripts so nothing waits for input.

## More messages

- The startup warning that `quickservicets` is using the in-memory database in production (`...; every restart loses all data. Set database in quickservicets.config.ts.`): the project names no `database` (or has no `quickservicets.config.ts`), so it runs on memory. Set `database` to `sqliteAdapter`, `postgresAdapter` or `mongodbAdapter`, then rebuild, `migration add` and `migrate`.
- `Warning: File is no longer built because no entity, storage or feature uses it; ...` (or `Media`): the last migration created the table, and nothing uses the entity any more. Review the drop the next `migration add` proposes, or set `storage` in `quickservicets.config.ts` to keep it.
- `server.workers > 1 requires a database server (PostgreSQL or MongoDB)`: set `server.workers` to 1 (or `QS_WORKERS=1`) with SQLite or the memory database.
- `Unknown command: <name>` with `Did you mean <name>?`: run `bun run quickservicets help` to list the commands.
- A 400 `VALIDATION_ERROR` lists each field in `error.details`; a 409 `CONFLICT` is a `@unique` value that exists.
- `.all()` without a condition is a type error: use `.toArray()` to read records.

After any fix, run `bun run build` and `bun run typecheck` again.

Full docs: [Errors reference](/reference/errors/) and [CLI reference](/reference/cli/).

## Do not

- Do not create tables by hand or edit an applied migration to fix a missing table; add a new migration.
- Do not delete `.generated/` to fix an error; it is rebuilt from the sources, so fix the source.
- Do not silence a build error by removing the tag or the field; fix what the message names.
- Do not raise `repositories.toArrayMax` before trying paging.
- Do not ignore the migration warning; the next deployment would miss the table.
