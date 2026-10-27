import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/http");
const guide = readFileSync(join(content, "guides/http-client.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the HTTP client guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/quote/get.ts", "jobs/quote-of-the-day.ts", "quickservicets.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## The builder and its terminals",
      "## Errors and their codes",
      "## The 502, 503 and 504 answers",
      "## Timeouts and size limits",
      "## SSRF protection and `allow`",
      "## Named services and authentication",
      "## Propagation",
      "## Call logging and masking",
      "## Modifiers",
      "**Retry**",
      "**Circuit breaker**",
      "**Bulkhead**",
      "**Cache**",
      "defineModifier",
      "## `http.mock()` in tests",
      "## Environment overrides",
      "## Per-request functions",
      "## Hooks",
      "## Transports",
      "## Eject",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it is in the Guides sidebar, and the configuration and jobs guides link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(readFileSync(join(content, "guides/configuration.md"), "utf8")).toContain("(/guides/http-client/)");
    expect(readFileSync(join(content, "guides/jobs.md"), "utf8")).toContain("(/guides/http-client/)");
  });
});
