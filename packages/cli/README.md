# @quickservicets/cli

The `quickservicets` command of [QuickService.ts](https://github.com/ricardorauber/quickservicets), a backend framework for [Bun](https://bun.sh): create projects, build them, run the dev server, and add and apply migrations.

```bash
bunx quickservicets init my-api
cd my-api
bun install
bun run dev
```

The project runs on the in-memory database; `init my-api --db sqlite` (or `postgres`, `mongodb`) chooses another. Run `quickservicets help` for every command. Projects created with `init` depend on this package and on [`@quickservicets/core`](https://www.npmjs.com/package/@quickservicets/core).

Documentation and source: https://github.com/ricardorauber/quickservicets

MIT license.
