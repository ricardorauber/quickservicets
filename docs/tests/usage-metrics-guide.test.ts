import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/metrics");
const guide = readFileSync(join(content, "guides/usage-metrics.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the usage metrics guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/posts/feed/get.ts", "quickservicets.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## What is measured",
      "## How quantiles are computed",
      "1% relative accuracy",
      "## Windows and rollups",
      "## Dimensions and cardinality",
      "metrics.series.overflow",
      "## Stores across workers and replicas",
      "metrics/rollup",
      "## The JSON form",
      "## The Prometheus format",
      "scrape_configs",
      "## Access control",
      "## Usage metrics and the meter interface",
      "setMeter",
      "## Cost",
      "## Customization",
      "Level 7",
    ]) {
      expect(guide.includes(topic) ? topic : `missing ${topic}`).toBe(topic);
    }
  });

  test("it is in the Guides sidebar, and the configuration guide, the features guide and the guides index link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    for (const page of ["guides/configuration.md", "guides/features.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/usage-metrics/)");
  });
});
