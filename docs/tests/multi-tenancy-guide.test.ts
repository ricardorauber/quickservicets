import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/tenancy");
const guide = readFileSync(join(content, "guides/multi-tenancy.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the multi-tenancy guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/plans/get.ts", "entities/Plan.ts", "jobs/digest.ts", "queues/notify.ts", "quickservicets.config.ts", "scripts/seed.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## Tenants and the request",
      "## Resolution sources and their order",
      "## The directory and its cache",
      "## Shared and tenant entities",
      "## Two strategies",
      "## Pools and their limits",
      "## Connections",
      "## Migrations and the tenants commands",
      "## Background work",
      "## The relay and its delivery",
      "at least once",
      "## Logs and reports",
      "## Isolation testing",
      "## Customization",
      "## Deleting a tenant's data",
      "after a backup",
    ]) {
      expect(guide.includes(topic) || guide.toLowerCase().includes(topic.toLowerCase()) ? topic : `missing ${topic}`).toBe(topic);
    }
  });

  test("it is in the Guides sidebar; the recipe, the configuration guide, the guides index and the features table link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    const recipe = readFileSync(join(content, "recipes/multi-tenant.md"), "utf8");
    const firstParagraph = recipe.split("---")[2]!.trim().split("\n\n")[0]!;
    expect(firstParagraph).toContain("(/guides/multi-tenancy/)");
    for (const page of ["guides/configuration.md", "guides/index.md", "guides/features.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/multi-tenancy/)");
  });
});
