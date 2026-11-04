import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const guide = readFileSync(join(content, "guides/deploy-targets.md"), "utf8");

describe("the deploy targets guide", () => {
  test("it covers the targets, function mode, the platform handler, bundles, lazy loading, cold starts, each platform and every level", () => {
    for (const heading of ["## The targets", "## Function mode", "## The platform handler", "## Bundles and binaries", "## Lazy loading and startup time", "## Cold starts", "## AWS Lambda", "## Azure Functions", "## Google Cloud Run", "## Customization levels"]) {
      expect(guide).toContain(heading);
    }
    for (const item of [
      "Use it for",
      "SQS or Service Bus trigger",
      "WebSockets need a server target",
      "deploy.lambda.streaming",
      "req.platform",
      "createServiceHandler",
      " migrate",
      "assetPath",
      "@preload",
      "benchmarks/results/cold-start.json",
      "function URL",
      "API Gateway",
      "--custom",
      "gcloud run services replace",
      "onPlatformEvent",
      "deploy/<target>/entry.ts",
      "deploy.targets",
      "eject deploy",
      "examples/minimal/deploy",
    ]) {
      expect(guide).toContain(item);
    }
  });

  test("the getting-started page, the configuration guide and the guides index link to it", () => {
    for (const page of ["getting-started/installation.md", "guides/configuration.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/deploy-targets/)");
  });
});
