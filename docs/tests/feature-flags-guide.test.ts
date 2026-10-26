import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/flags");
const guide = readFileSync(join(content, "guides/feature-flags.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the feature flags guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/checkout/post.ts", "endpoints/settings/get.ts", "features/demo-user/index.ts", "jobs/flag-report.ts", "quickservicets.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## Enabling flags",
      "## Rules and their order",
      "## Percentage rollouts",
      "## `req.flags`",
      "## `@flag` and the 404 answer",
      "## Flags in jobs and queue consumers",
      "## The database source",
      "quickservicets flags set",
      "## Environment overrides",
      "QS_FLAGS_RULES_CHECKOUT_V2",
      "## Function rules",
      "## `onEvaluate`",
      "## Providers",
      "## Eject",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it is in the Guides sidebar, and the configuration and hooks guides link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(readFileSync(join(content, "guides/configuration.md"), "utf8")).toContain("(/guides/feature-flags/)");
    expect(readFileSync(join(content, "guides/hooks.md"), "utf8")).toContain("(/guides/feature-flags/)");
  });
});
