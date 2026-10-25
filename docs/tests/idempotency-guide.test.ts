import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/idempotency");
const guide = readFileSync(join(content, "guides/idempotency.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the idempotency guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/payments/post.ts", "entities/Order.ts", "quickservice.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## The header",
      "## Scope and fingerprint",
      "## Replay",
      "## The 409 and 422 answers",
      "IDEMPOTENCY_KEY_IN_USE",
      "IDEMPOTENCY_KEY_REUSED",
      "## What is stored and released",
      "## Expiry",
      "## Tags",
      "## Per-request options",
      "## Hooks",
      "## The store",
      "## Client-side retries",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it is in the Guides sidebar, the configuration guide links to it, and the recipe exists", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(readFileSync(join(content, "guides/configuration.md"), "utf8")).toContain("(/guides/idempotency/)");
    const recipe = readFileSync(join(content, "recipes/safe-checkout.md"), "utf8");
    expect(recipe).toContain("idempotency-key");
    expect(recipe).toContain("(/guides/idempotency/)");
    expect(guide).toContain("(/recipes/safe-checkout/)");
  });
});
