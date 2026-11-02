import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/secrets");
const guide = readFileSync(join(content, "guides/secrets.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the secrets guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()]).toEqual(["quickservicets.config.ts", "vault/local-vault.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## Why references",
      "## The reference syntax",
      "## Where references work",
      "## Startup resolution and its errors",
      "## Caching, TTLs and leases",
      "## Rotation and what picks it up",
      "## Per-tenant secrets",
      "## Health",
      "## `secrets check` in CI and deploys",
      "## Masking",
      "## Writing a provider",
      "## Customization",
      "Level 7",
      "## Vault providers",
    ]) {
      expect(guide.includes(topic) ? topic : `missing ${topic}`).toBe(topic);
    }
  });

  test("it is in the Guides sidebar, and the environment guide, the features guide and the guides index link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    for (const page of ["guides/environment.md", "guides/features.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/secrets/)");
  });
});
