import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/health");
const guide = readFileSync(join(content, "guides/health.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the health guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["features/mail/index.ts", "quickservicets.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic, with Kubernetes values matching the defaults", () => {
    for (const topic of [
      "## Liveness and readiness",
      "## The checks",
      "## Adding checks",
      "## Caching",
      "## Production details",
      "## Draining on shutdown",
      "## Load balancers",
      "## Customization levels",
      "livenessProbe:",
      "readinessProbe:",
      "path: /health/live",
      "path: /health/ready",
      "timeoutSeconds: 3",
      "terminationGracePeriodSeconds: 30",
      "default `2s`",
      "default `1s`",
      "default `5s` in production",
      "`lifecycle.stopTimeout` (default `10s`)",
      "QS_HEALTH_DRAIN_DELAY",
      "runHealthChecks()",
      "`prober`",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it is in the Guides sidebar and the configuration guide links to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(guide).toContain("(/reference/features/health/)");
    expect(readFileSync(join(content, "guides/configuration.md"), "utf8")).toContain("(/guides/health/)");
  });
});
