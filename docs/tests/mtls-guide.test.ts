import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/security");
const guide = readFileSync(join(content, "guides/mtls.md"), "utf8");

describe("the mTLS guide", () => {
  test("it covers every topic", () => {
    for (const topic of [
      "## Where to terminate TLS and mTLS",
      "## Server certificates and reloads",
      "## Client certificates and modes",
      "## req.client",
      "## Allowlist patterns",
      "uri:spiffe://",
      "sha256:",
      "dns:",
      "## The @mtls tag",
      "## Forwarded certificates",
      "Only the proxies in `forwarded.trust`",
      "## Certificates for outgoing calls",
      "## Certificate identities as users",
      "certificateAuth",
      "## WebSockets",
      "## The cost of verifying in the service",
      "## Customization",
      "Level 7",
    ]) {
      expect(guide.includes(topic) ? topic : `missing ${topic}`).toBe(topic);
    }
  });

  test("its tag sample is the example's sync endpoint", () => {
    expect(readFileSync(join(example, "endpoints/internal/sync/post.ts"), "utf8")).toContain("@mtls allow=CN=billing");
    expect(guide).toContain("/** @mtls allow=CN=billing */");
  });

  test("it is in the Guides sidebar, and the security guide, the configuration guide and the guides index link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    for (const page of ["guides/security.md", "guides/configuration.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/mtls/)");
  });
});
