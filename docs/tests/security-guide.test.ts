import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/security");
const guide = readFileSync(join(content, "guides/security.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the security guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/admin/stats/get.ts", "endpoints/login/post.ts", "entities/Customer.ts", "features/audit/index.ts", "quickservice.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every item with its defaults, threats and responses, the order, proxies, stores and the checks", () => {
    for (const topic of [
      "| `proxy` |",
      "| `headers` |",
      "| `files` |",
      "| `cors` |",
      "| `limits` |",
      "| `timeouts` |",
      "| `loadShedding` |",
      "| `rateLimit` |",
      "| `ip` |",
      "| `masking` |",
      "## The order of the items",
      "load shedding, URL and header limits, IP lists, CORS, rate limits",
      "### Trusted proxies",
      "proxy.trust",
      "per-worker memory counters",
      'rateLimit.store: "database"',
      "`429 Too many requests`",
      "`503 Server is busy`",
      "`408`",
      "`414`, `431`, `413`",
      "runAttackSuite",
      "The `unsafe()` rule",
      "`bun run audit`",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it states what must be handled before the application", () => {
    expect(guide).toContain("Volumetric DDoS and caps on TCP connections must be handled before the application");
    expect(guide).toContain("Load shedding only keeps one worker responsive");
    expect(guide).toContain("Files in `direct` mode are served by the storage or the CDN, which need the `nosniff`, sandboxing and `attachment` headers set there.");
  });

  test("it is in the Guides sidebar, links to the reference, and the configuration and files guides link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(guide).toContain("(/reference/features/security/)");
    for (const page of ["guides/configuration.md", "guides/files.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/security/)");
  });
});
