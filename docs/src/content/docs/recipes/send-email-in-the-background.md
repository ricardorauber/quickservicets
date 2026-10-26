---
title: Send an email in the background
description: Send a welcome email after a signup without making the client wait, once per user, retried when the mail server fails.
sidebar:
  order: 23
---

**The problem:** a signup should answer at once, but the welcome email goes through a mail server that is sometimes slow or down. You want the email sent in the background, retried when it fails, and never sent twice to the same user, even when the client retries the signup or two workers handle it.

**The solution:** a post-hook on the `create` route of `User` adds a message to a [queue](/guides/queues/) with a dedupe key; the queue's consumer sends the email with retries and backoff, and a message that keeps failing waits in the dead letter until someone requeues it.

## Turn queues on

```ts title="quickservicets.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: "data.db" }),
  queues: {},
});
```

```bash
bun run quickservicets migration add Queues
bun run quickservicets migrate
```

## The consumer

The consumer sends one email; a throw fails the attempt, which is retried after 30 seconds, then a minute, then two, before the message is dead. `dedupeWindow` keeps the key of a sent email for a week, so the same user never gets it twice:

```ts title="queues/welcome-email.ts"
import { queue } from "@quickservicets/core";
import { sendMail } from "../mail.ts";

export default queue<{ userId: string }>(
  async ({ payload, repos, signal }) => {
    const user = await repos.users.findById(payload.userId);
    if (!user) return { skipped: true };
    await sendMail({ to: user.email, subject: "Welcome!", signal });
    return { sentTo: user.email };
  },
  { retries: 3, retryDelay: "30s", timeout: "1m", dedupeWindow: "7d" },
);
```

## The hook

A post-hook runs after the user was created and adds the message; the dedupe key makes a repeated signup, or two workers running the hook, add one message:

```ts title="hooks/sendWelcome.ts"
import { definePostHook } from "@quickservicets/core";

export default definePostHook(async (data, _repos, req) => {
  const user = data as { id: string };
  await req.queue.add("welcome-email", { userId: user.id }, { dedupeKey: `welcome:${user.id}` });
  return data;
});
```

```ts title="entities/User.ts"
/** @sendWelcome:create */
export type User = {
  /** @unique @format email */
  email: string;
  name: string;
};
```

`POST /users` answers as soon as the user is stored; the email follows within a second.

## When the mail server is down

Each failure is logged with `queue.message.failed`, and the last one with `queue.message.dead`. Once the server is back, requeue the dead messages:

```bash
bun run quickservicets queue dead welcome-email
bun run quickservicets queue retry --queue welcome-email --dead
```

## See also

- [Queues](/guides/queues/): options, retries, dedupe, `@publish`, brokers and the CLI.
- [Hooks](/guides/hooks/): pre- and post-hooks on entity routes.
