# quickservicets

The command of [QuickService.ts](https://github.com/ricardorauber/quickservicets), a backend framework for [Bun](https://bun.sh): write your entities as TypeScript types and get a typed, validated and documented REST API.

```bash
bunx quickservicets init my-api
cd my-api
bun install
bun run dev
```

The project runs on the in-memory database; pass `--db sqlite`, `--db postgres` or `--db mongodb` to `init` for another. This package only runs the CLI of [`@quickservicets/cli`](https://www.npmjs.com/package/@quickservicets/cli); `bunx quickservicets <command>` behaves exactly like it. Projects depend on `@quickservicets/core` and `@quickservicets/cli`.

Documentation and source: https://github.com/ricardorauber/quickservicets

MIT license.
