import { describe, expect, test } from "bun:test";
import { startTestService, type TestService } from "@quickservicets/cli/testing";
import { cidrMatcher } from "@quickservicets/core";
import { compileLists, ipStep } from "../../../core/src/features/security/ip.ts";

const CONFIG = (security = "", extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter()${security ? `, security: ${security}` : ""}${extra ? `, ${extra}` : ""} });
`;
const POST = "export type Post = { title: string };\n";
const endpoint = (tag: string) => `import type { Endpoint } from "@quickservicets/core";\n/** ${tag} */\nconst handler: Endpoint = () => ({ ok: true });\nexport default handler;\n`;
const PROBES = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "probes",
  after: ["security"],
  setup(ctx) {
    ctx.feature("security").exempt("/health/*", ["ip"]);
    ctx.app.route("GET", "/health/live", () => ({ status: "ok" }));
  },
});
`;

async function withService(files: Record<string, string>, run: (service: TestService) => Promise<void>, env?: Record<string, string>): Promise<void> {
  const service = await startTestService({ files: { "entities/Post.ts": POST, ...files }, ...(env ? { env } : {}) });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}
const statusOf = async (service: TestService, path: string, peer?: string) => (await service.fetch(path, peer === undefined ? {} : { peer })).status;

describe("matching", () => {
  test("CIDR blocks and named ranges, IPv4-mapped addresses as IPv4, and IPv6 prefixes", () => {
    const matches = cidrMatcher(["10.0.0.0/8", "2001:db8::/32", "loopback"]);
    expect(matches("::ffff:10.1.2.3")).toBe(true);
    expect(matches("2001:db8:1::5")).toBe(true);
    expect(matches("2001:db9::1")).toBe(false);
    expect(matches("127.0.0.1")).toBe(true);
    expect(matches("::1")).toBe(true);
    expect(matches("unknown")).toBe(false);
    expect(cidrMatcher(["private"])("192.168.4.4")).toBe(true);
    expect(cidrMatcher(["linklocal"])("fe80::1")).toBe(true);
  });

  test("allow, deny and unknown addresses", () => {
    const passes = compileLists({ allow: ["10.0.0.0/8"], deny: ["10.0.0.66"] })!;
    expect(passes("10.1.2.3")).toBe(true);
    expect(passes("10.0.0.66")).toBe(false);
    expect(passes("192.168.0.1")).toBe(false);
    expect(passes("unknown")).toBe(false);
    const denyOnly = compileLists({ allow: [], deny: ["203.0.113.0/24"] })!;
    expect(denyOnly("unknown")).toBe(true);
    expect(denyOnly("203.0.113.9")).toBe(false);
    expect(compileLists({ allow: [], deny: [] })).toBeUndefined();
  });
});

describe("global lists", () => {
  test("a deny list refuses its addresses with 403 Address not allowed", async () => {
    await withService({ "quickservicets.config.ts": CONFIG('{ ip: { deny: ["203.0.113.0/24"] } }') }, async (service) => {
      const refused = await service.fetch("/posts", { peer: "203.0.113.9" });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: { code: "FORBIDDEN", message: "Address not allowed" } });
      expect(await statusOf(service, "/posts", "198.51.100.1")).toBe(200);
    });
  });

  test("an allow list with a deny entry, and a request with no peer", async () => {
    await withService({ "quickservicets.config.ts": CONFIG('{ ip: { allow: ["10.0.0.0/8"], deny: ["10.0.0.66"] } }') }, async (service) => {
      expect(await statusOf(service, "/posts", "10.1.2.3")).toBe(200);
      expect(await statusOf(service, "/posts", "10.0.0.66")).toBe(403);
      expect(await statusOf(service, "/posts", "192.168.0.1")).toBe(403);
      expect(await statusOf(service, "/posts")).toBe(403);
    });
  });

  test("QS_SECURITY_IP_DENY refuses that address", async () => {
    await withService({ "quickservicets.config.ts": CONFIG() }, async (service) => {
      expect(await statusOf(service, "/posts", "203.0.113.9")).toBe(403);
      expect(await statusOf(service, "/posts", "203.0.113.10")).toBe(200);
    }, { QS_SECURITY_IP_DENY: "203.0.113.9" });
  });
});

describe("route tags", () => {
  test("@ipAllow narrows one route, the rest stays open; an invalid entry fails the build", async () => {
    await withService({ "quickservicets.config.ts": CONFIG(), "endpoints/admin/stats/get.ts": endpoint("@ipAllow private,loopback") }, async (service) => {
      expect(await statusOf(service, "/admin/stats", "203.0.113.5")).toBe(403);
      expect(await statusOf(service, "/admin/stats", "10.0.0.5")).toBe(200);
      expect(await statusOf(service, "/admin/stats", "127.0.0.1")).toBe(200);
      expect(await statusOf(service, "/posts", "203.0.113.5")).toBe(200);
    });
    const error = await startTestService({ files: { "quickservicets.config.ts": CONFIG(), "entities/Post.ts": POST, "endpoints/admin/stats/get.ts": endpoint("@ipAllow 10.0.0.300") } }).then(
      (service) => service.stop().then(() => "built"),
      (failure: Error) => failure.message,
    );
    expect(error).toContain("invalid @ipAllow");
  });

  test("route lists add to the global ones, and an endpoint's tag wins over its entity's", async () => {
    const files = {
      "quickservicets.config.ts": CONFIG('{ ip: { deny: ["198.51.100.66"] } }'),
      "entities/Post.ts": "/** @ipDeny 203.0.113.0/24 */\nexport type Post = { title: string };\n",
      "endpoints/posts/get.ts": endpoint("@ipDeny 192.0.2.0/24"),
    };
    await withService(files, async (service) => {
      // The endpoint replaces the generated list route, with its own @ipDeny.
      expect(await statusOf(service, "/posts", "203.0.113.5")).toBe(200);
      expect(await statusOf(service, "/posts", "192.0.2.5")).toBe(403);
      expect(await statusOf(service, "/posts", "198.51.100.66")).toBe(403);
      // Other routes of the entity keep its tag.
      expect(await statusOf(service, "/posts/123", "203.0.113.5")).toBe(403);
    });
  });
});

describe("exemptions and the no-work path", () => {
  test("an exempted path skips the global lists", async () => {
    await withService({ "quickservicets.config.ts": CONFIG('{ ip: { allow: ["10.0.0.0/8"] } }', "probes: {}"), "features/probes/index.ts": PROBES }, async (service) => {
      expect(await statusOf(service, "/health/live", "203.0.113.5")).toBe(200);
      expect(await statusOf(service, "/posts", "203.0.113.5")).toBe(403);
    });
  });

  test("with empty lists and no tags there is no step and no matcher call", () => {
    let calls = 0;
    const spying = (entries: readonly string[]) => {
      const matches = cidrMatcher(entries);
      return (address: string) => (calls++, matches(address));
    };
    expect(ipStep({ allow: [], deny: [] }, () => "203.0.113.5", [], spying)).toBeUndefined();
    expect(calls).toBe(0);
    const step = ipStep({ allow: [], deny: ["203.0.113.0/24"] }, () => "198.51.100.1", [], spying)!;
    step.before!({ exempt: 0, route: undefined, ctx: { request: new Request("http://localhost/") } } as never);
    expect(calls).toBe(1);
  });
});
