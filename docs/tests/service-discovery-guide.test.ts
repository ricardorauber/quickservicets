import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const guide = readFileSync(join(content, "guides/service-discovery.md"), "utf8");

describe("the service discovery guide", () => {
  test("it covers registration, providers, discovery, balancing, zones, ejection, probes, versions, SSRF trust and every level", () => {
    for (const heading of ["## Registration", "## Heartbeats and draining order", "## Choosing a provider", "## Static services", "## DNS", "## Discovered services and balancing", "## The API gateway", "## SSRF trust", "## Versions and canaries", "## Ejection and panic", "## Active probes", "## Providers", "## Customization levels"]) {
      expect(guide).toContain(heading);
    }
    for (const item of ["Consul", "etcd", "Eureka", "Cloud Map", "Kubernetes", "round-robin", "least-connections", "preferZone", "maxEjectedPercent", "registry.panic", "billing@^2", "prefer", "169.254.169.254", "QS_REGISTRY_VERSION", "beforeRegister", "onEjected", "balancer", "runRegistryProviderContract", "eject registry", "examples/minimal/registry"]) {
      expect(guide).toContain(item);
    }
  });

  test("the HTTP client guide, the API gateway guide and the guides index link to it", () => {
    for (const page of ["guides/http-client.md", "guides/api-gateway.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/service-discovery/");
  });
});
