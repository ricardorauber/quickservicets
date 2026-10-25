import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/queues");
const guide = readFileSync(join(content, "guides/queues.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the queues guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/users/[id]/welcome/post.ts", "entities/User.ts", "memory-broker.ts", "queues/events.ts", "queues/send-email.ts", "quickservice.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## Declaring consumers",
      "## Payload types",
      "## Adding messages",
      "| `delay` |",
      "| `runAt` |",
      "| `priority` |",
      "| `dedupeKey` |",
      "## Transactions",
      "## Processing, concurrency, workers and replicas",
      "## Retries and backoff",
      "## Timeouts",
      "## Dead letter and the CLI",
      "quickservice queue list",
      "## Retention",
      "## Publishing entity events with `@publish`",
      "## Overrides and variables",
      "QS_QUEUES_OVERRIDES_SEND_EMAIL_CONCURRENCY",
      "## Hooks and events",
      "beforeEnqueue",
      "onDead",
      "queue.message.dead",
      "## Brokers and the contract kit",
      "runQueueBrokerContract",
      "## Queues or jobs",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it is in the Guides sidebar, and the configuration guide, the jobs guide and the guides index link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(guide).toContain("(/reference/features/queues/)");
    for (const page of ["guides/configuration.md", "guides/jobs.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/queues/)");
  });

  test("the recipe exists and links to the guide, which links back", () => {
    const recipe = join(content, "recipes/send-email-in-the-background.md");
    expect(existsSync(recipe)).toBe(true);
    const text = readFileSync(recipe, "utf8");
    expect(text).toContain("(/guides/queues/)");
    expect(text).toContain("dedupeKey");
    expect(text).toContain("retries: 3");
    expect(guide).toContain("(/recipes/send-email-in-the-background/)");
  });
});
