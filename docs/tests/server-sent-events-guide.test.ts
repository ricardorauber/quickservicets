import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/realtime");
const guide = readFileSync(join(content, "guides/server-sent-events.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the Server-Sent Events guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/clock/sse.ts", "entities/Task.ts", "quickservicets.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## `sse.ts` endpoints",
      "## The stream",
      "## Heartbeats and proxies",
      "x-accel-buffering",
      "## Change streams",
      "## Filters",
      "## Permissions",
      "## Resume and `reset`",
      "Last-Event-ID",
      "## Workers and the outbox",
      "## Limits",
      "## Customization",
      "beforeDeliver",
      "beforeSend",
      "changeSource",
      "quickservicets eject realtime",
      "new EventSource(",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it is in the Guides sidebar, and the configuration and events guides link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(readFileSync(join(content, "guides/configuration.md"), "utf8")).toContain("(/guides/server-sent-events/)");
    expect(readFileSync(join(content, "guides/events.md"), "utf8")).toContain("(/guides/server-sent-events/)");
  });
});
