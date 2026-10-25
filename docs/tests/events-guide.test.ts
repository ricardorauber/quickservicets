import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/events");
const guide = readFileSync(join(content, "guides/events.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the events guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/posts/[id]/publish/post.ts", "event-map.ts", "events/count-comments.ts", "features/notify/events/notify.ts", "features/notify/index.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers transactions, write events, listeners, patterns, custom events, listener files, the outbox, consumers and every customization level", () => {
    for (const topic of [
      "repos.transaction(fn)",
      "afterCommit(fn)",
      "onRollback(fn)",
      "joins it",
      "standalone MongoDB",
      "`cascade`",
      "`setNull`",
      "`pull`",
      "`touch`",
      "deepest cascades first",
      "`inTransaction`",
      "event.listener.failed",
      "`*.written`",
      "events.emit(type, payload)",
      "`EventMap`",
      "listen(pattern, listener, options?)",
      "events: { outbox: true }",
      "tailOutbox",
      "**at least once**",
      "idempotent",
      "events outbox",
      "events retry",
      "`@events off`",
      "currentOperation()",
      "`beforeEmit(event, { operation })`",
      "`bus: { publish, subscribe }`",
      "quickservice eject events",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it links to the reference page, and the configuration and hooks guides link to it", () => {
    expect(guide).toContain("(/reference/features/events/)");
    for (const page of ["guides/configuration.md", "guides/hooks.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/events/)");
  });
});
