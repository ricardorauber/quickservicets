import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/errors");
const guide = readFileSync(join(content, "guides/error-reporting.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the error reporting guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/boom/get.ts", "jobs/sync-invoices.ts", "quickservice.config.ts", "reporters.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of ["## The interface", "## What is reported, and when", "## The report", "## Masking", "## The console reporter", "## Writing a reporter", "## Flushing", "## Customization", "sampleRate", "ignore", "@report off", "beforeReport", "quickservice eject errors"]) {
      expect(guide).toContain(topic);
    }
  });

  test("it is in the Guides sidebar and the configuration guide links to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(readFileSync(join(content, "guides/configuration.md"), "utf8")).toContain("(/guides/error-reporting/)");
  });
});
