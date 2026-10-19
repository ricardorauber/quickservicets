---
title: Scheduled cleanup
description: A nightly job that deletes expired sessions, and an admin endpoint that runs it on demand and reports how it went.
sidebar:
  order: 22
---

**The problem:** sessions pile up long after they expire. You want them deleted every night, while traffic is low, and you want an admin to be able to start the same cleanup right away, for example after a security incident, and see how it went.

**The solution:** a [job](/guides/jobs/) in `jobs/` scheduled at 03:00 local time, an admin-only endpoint that starts it with `req.jobs.run`, and a second endpoint that reads the run record from `repos.jobRuns`.

The steps below start from a fresh project made with `init --db sqlite` (see [Installation and init](/getting-started/installation/)). Run the commands inside the project.

## The model

```ts check title="entities/Session.ts"
export type Session = {
  /** @unique */
  token: string;
  userEmail: string;
  expiresAt: Date;
};
```

```bash
bun run quickservice migration add Initial
bun run quickservice migrate
```

```text
Created migrations/20261019154452_Initial.ts
Applied 20261019154452_Initial
```

<details>
<summary>The generated types these snippets rely on (excerpt of <code>.generated/</code>)</summary>

The build writes these files for you; they are shown here so the snippets on this page type-check on their own.

```ts check title=".generated/types.ts"
import type { ReadRepository, Repository } from "@quickservice/core";

export type Session = { id: string; createdAt: Date; updatedAt: Date; token: string; userEmail: string; expiresAt: Date };
export type SessionCreate = { token: string; userEmail: string; expiresAt: Date };
export type SessionUpdate = Partial<SessionCreate>;

export type JobRun = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  job: string;
  trigger: "schedule" | "manual" | "code";
  scheduledAt: Date;
  attempt: number;
  status: "running" | "success" | "failed" | "timedOut" | "skipped" | "abandoned" | "interrupted";
  startedAt: Date;
  finishedAt?: Date | null;
  durationMs?: number | null;
  heartbeatAt?: Date | null;
  result?: unknown | null;
  error?: { message: string; stack?: string | null } | null;
  logs: Array<{ level: "info" | "warn" | "error"; message: string; at: string; fields?: unknown | null }>;
};

export interface GeneratedRepositories {
  sessions: Repository<Session, Record<never, never>, SessionCreate, SessionUpdate>;
  jobRuns: ReadRepository<JobRun>;
}

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

```ts check title=".generated/jobs.ts"
declare module "@quickservice/core" {
  interface JobNames {
    "cleanup/expired-sessions": true;
  }
}

export {};
```

</details>

## The job

The file `jobs/cleanup/expired-sessions.ts` declares the job `cleanup/expired-sessions`. It runs at 03:00 in São Paulo, deletes the sessions that had expired when it started, 100 at a time, and returns how many it deleted, which ends up in the run record:

```ts check title="jobs/cleanup/expired-sessions.ts"
import { job } from "@quickservice/core";

const BATCH_SIZE = 100;

/** Deletes the sessions that expired before the run started, 100 at a time. */
export default job(
  "0 3 * * *",
  async ({ repos, signal, log }) => {
    const now = new Date();
    let deleted = 0;
    for (;;) {
      signal.throwIfAborted();
      const batch = await repos.sessions.where((s) => s.expiresAt.lt(now)).take(BATCH_SIZE).all();
      if (batch.length === 0) break;
      for (const session of batch) await repos.sessions.delete(session.id);
      deleted += batch.length;
    }
    log.info("Expired sessions deleted", { deleted });
    return { deleted };
  },
  { timeZone: "America/Sao_Paulo", timeout: "10m", retries: 2, retryDelay: "1m" },
);
```

- `signal.throwIfAborted()` stops the loop between batches when the run times out or the server shuts down, so a stopped run never keeps deleting in the background.
- Each batch is a fresh query, so a run that fails halfway, and is retried a minute later, picks up where it stopped.
- `timeout: "10m"` gives a large backlog room; two retries, 1 and 2 minutes apart, cover a database that is briefly unavailable.

## The admin hook

Both endpoints are for admins only. This pre-hook compares the bearer token with `ADMIN_TOKEN`; add `ADMIN_TOKEN=admin-secret` to `.env` for the requests below. A real service would check a user's role instead, as in [Permission checks](/recipes/permission-checks/).

```ts check title="hooks/admin.ts"
import { definePreHook, HttpError } from "@quickservice/core";

/** Lets through requests that send `Authorization: Bearer <ADMIN_TOKEN>`. */
export default definePreHook(
  (_repos, req) => {
    const token = process.env.ADMIN_TOKEN;
    if (!token || req.headers.get("authorization") !== `Bearer ${token}`) throw new HttpError(403, "Admins only");
  },
  { docs: { responses: [403], security: "bearer" } },
);
```

## The trigger endpoint

`POST /admin/cleanup/expired-sessions` starts a run and answers `202 Accepted` with its id at once; the job keeps running in the background. `req.jobs.run` only accepts the names of the project's jobs, so a typo fails the type check. `?force=true` runs the cleanup even while another run of it is still going.

```ts check title="endpoints/admin/cleanup/expired-sessions/post.ts"
import type { Endpoint } from "@quickservice/core";

type Query = {
  /**
   * Run even when a cleanup is already running.
   * @default false
   */
  force?: boolean;
};

/**
 * @summary Run the expired-sessions cleanup now
 * @status 202
 * @admin
 */
const handler: Endpoint<Query, { runId: string }> = (_repos, req) =>
  req.jobs.run("cleanup/expired-sessions", { force: req.queryItems.force });

export default handler;
```

## The run endpoint

Run records have no HTTP routes of their own. `repos.jobRuns` reads them, so a small endpoint lets an admin follow the run they started:

```ts check title="endpoints/admin/job-runs/[runId]/get.ts"
import { HttpError, type Endpoint } from "@quickservice/core";
import type { JobRun } from "../../../../.generated/types.ts";

/**
 * @summary A job run, to follow a cleanup started on demand
 * @admin
 */
const handler: Endpoint<unknown, JobRun> = async (repos, req) => {
  const run = await repos.jobRuns.findById(req.params.runId!);
  if (!run) throw new HttpError(404, "Job run not found");
  return run;
};

export default handler;
```

## Build and migrate

The first job adds the built-in `JobRun` entity to the model, so the build asks for a migration:

```bash
bun run quickservice build
```

```text
Built 4 entities, 2 custom endpoints and 1 hooks.
Warning: Model has changes without a migration. Run "quickservice migration add <Name>"
```

(The four entities are `Session`, `JobRun` and the built-in `File` and `Media`.) The migration creates the `job-runs` table:

```bash
bun run quickservice migration add AddJobRuns
bun run quickservice migrate
```

```text
Created migrations/20261019154454_AddJobRuns.ts
Applied 20261019154454_AddJobRuns
```

`bun run quickservice job list` shows when the next scheduled run is, in UTC:

```bash
bun run quickservice job list
```

```text
JOB                       SCHEDULE   TIME ZONE          NEXT RUN
cleanup/expired-sessions  0 3 * * *  America/Sao_Paulo  2026-10-20T06:00:00.000Z
```

## Try it

Start the server with `bun run dev` and create three expired sessions and one that is still valid:

```bash
curl -X POST localhost:3000/sessions -H "content-type: application/json" \
  -d '{"token":"t1","userEmail":"ana@acme.co","expiresAt":"2026-10-01T00:00:00Z"}'
```

```json
{"id":"01a154ca-5447-76a7-8254-0216b65f3ce1","createdAt":"2026-10-19T15:31:48.424Z","updatedAt":"2026-10-19T15:31:48.424Z","token":"t1","userEmail":"ana@acme.co","expiresAt":"2026-10-01T00:00:00.000Z"}
```

The same for `t2` and `t3`, expired on October 2 and 3, and for `t4`, Bruno's session, which expires on `2027-01-01T00:00:00Z`.

Without the admin token, the hook stops the request:

```bash
curl -i -X POST localhost:3000/admin/cleanup/expired-sessions
```

```txt
HTTP/1.1 403 Forbidden

{"error":{"code":"FORBIDDEN","message":"Admins only"}}
```

With it, the run starts and the response carries its id:

```bash
curl -i -X POST localhost:3000/admin/cleanup/expired-sessions -H "Authorization: Bearer admin-secret"
```

```txt
HTTP/1.1 202 Accepted

{"runId":"01a154ca-5487-75b8-b0bb-1b5d40d1157b"}
```

The server log shows the run next to the request that started it, each line with the job and run id:

```json
{"level":"info","timestamp":"2026-10-19T15:31:48.488Z","message":"job.started","job":"cleanup/expired-sessions","runId":"01a154ca-5487-75b8-b0bb-1b5d40d1157b","status":"running"}
{"level":"info","timestamp":"2026-10-19T15:31:48.489Z","requestId":"01a154ca-5486-72cc-a574-f33278482355","method":"POST","route":"/admin/cleanup/expired-sessions","status":202,"durationMs":3.141,"hooks":["admin"]}
{"level":"info","timestamp":"2026-10-19T15:31:48.494Z","message":"Expired sessions deleted","deleted":3,"job":"cleanup/expired-sessions","runId":"01a154ca-5487-75b8-b0bb-1b5d40d1157b"}
{"level":"info","timestamp":"2026-10-19T15:31:48.495Z","message":"job.finished","job":"cleanup/expired-sessions","runId":"01a154ca-5487-75b8-b0bb-1b5d40d1157b","status":"success","durationMs":7}
```

The run record has the outcome, the returned value and the log line:

```bash
curl localhost:3000/admin/job-runs/01a154ca-5487-75b8-b0bb-1b5d40d1157b -H "Authorization: Bearer admin-secret"
```

```json
{"id":"01a154ca-5487-75b8-b0bb-1b5d40d1157b","createdAt":"2026-10-19T15:31:48.487Z","updatedAt":"2026-10-19T15:31:48.494Z","job":"cleanup/expired-sessions","trigger":"code","scheduledAt":"2026-10-19T15:31:48.486Z","attempt":1,"status":"success","startedAt":"2026-10-19T15:31:48.487Z","finishedAt":"2026-10-19T15:31:48.494Z","durationMs":7,"heartbeatAt":null,"result":{"deleted":3},"error":null,"logs":[{"level":"info","message":"Expired sessions deleted","at":"2026-10-19T15:31:48.494Z","fields":{"deleted":3}}]}
```

Only Bruno's session is left:

```bash
curl localhost:3000/sessions
```

```json
{"data":[{"id":"01a154ca-546e-7132-9ba3-6dd9494e1e88","createdAt":"2026-10-19T15:31:48.462Z","updatedAt":"2026-10-19T15:31:48.462Z","token":"t4","userEmail":"bruno@acme.co","expiresAt":"2027-01-01T00:00:00.000Z"}],"total":1,"limit":20,"offset":0}
```

An id that matches no run is a 404:

```bash
curl -i localhost:3000/admin/job-runs/01a10000-0000-7000-8000-000000000000 -H "Authorization: Bearer admin-secret"
```

```txt
HTTP/1.1 404 Not Found

{"error":{"code":"NOT_FOUND","message":"Job run not found"}}
```

## From the command line

`job run` runs the cleanup in the CLI process, without the server, which suits a deploy script or a one-off fix. It prints the run's log lines, then the outcome, and exits with 0 only on success:

```bash
bun run quickservice job run cleanup/expired-sessions
```

```text
{"level":"info","timestamp":"2026-10-19T15:32:00.225Z","message":"job.started","job":"cleanup/expired-sessions","runId":"01a154ca-825c-7132-a29b-70fdfa05f3a9","status":"running"}
{"level":"info","timestamp":"2026-10-19T15:32:00.230Z","message":"Expired sessions deleted","deleted":1,"job":"cleanup/expired-sessions","runId":"01a154ca-825c-7132-a29b-70fdfa05f3a9"}
{"level":"info","timestamp":"2026-10-19T15:32:00.231Z","message":"job.finished","job":"cleanup/expired-sessions","runId":"01a154ca-825c-7132-a29b-70fdfa05f3a9","status":"success","durationMs":10}
Job cleanup/expired-sessions: success in 10ms
Result: {"deleted":1}
```

`job runs` lists the latest runs, whatever started them:

```bash
bun run quickservice job runs cleanup/expired-sessions
```

```text
ATTEMPT  TRIGGER  STATUS   STARTED                   DURATION
1        manual   success  2026-10-19T15:32:00.220Z  10ms
1        code     success  2026-10-19T15:31:48.487Z  7ms
```

The nightly runs show up there with the trigger `schedule`, and the records are deleted after 30 days, the default [retention](/guides/jobs/#retention).

## Variations

**Run it more often.** For a busy service, `{ every: "15m" }` instead of the cron string keeps the table small all day; intervals are aligned to the clock, so it runs at :00, :15, :30 and :45.

**A cleanup that is already running.** With the default `overlap: "skip"`, a trigger that arrives while a run is still going stores a `skipped` record instead of a second run, and the run endpoint shows `"status":"skipped"`. Send `?force=true` to run anyway, or `--force` from the CLI.

**Only one instance runs it.** Every instance shares the run records, so with several replicas the nightly cleanup still runs once. To keep jobs off the instances that serve traffic, start those with `JOBS_ENABLED=false`; `req.jobs.run` keeps working there. See [Several instances](/guides/jobs/#several-instances).

## Related

- [Jobs](/guides/jobs/): schedules, options, run records, timeouts, retries and shutdown.
- [CLI: `job run`, `job list`, `job runs`](/reference/cli/#job-run)
- [Configuration](/reference/config/): the `jobs` defaults.
- [Hooks](/guides/hooks/): how the `admin` pre-hook is attached.

Previous: [Testing your API in-process](/recipes/testing/). That is the last recipe; back to the [Guides](/guides/).
