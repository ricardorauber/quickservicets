import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { memoryAdapter, registerProjectFeatures, resolveConfig, type ServiceConfig } from "@quickservicets/core";
import { runTenantIsolationSuite } from "@quickservicets/core/testing";
import { createLinkedProject } from "../testing/project.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/tenancy");

/** The files of a project folder, without generated, installed and test files. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!entry.isFile() || /^(node_modules|\.generated|tests|scripts)\//.test(path) || !path.endsWith(".ts")) continue;
    files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

// The ejected copy is registered as the project's tenancy feature, so the isolation suite below runs on it.
const root = createLinkedProject(filesOf(example));
const lines = await eject(root, "tenancy");
const ejected = (await import(join(root, "features/tenancy/index.ts"))) as { default: unknown };
registerProjectFeatures([{ folder: "tenancy", definition: ejected.default }]);
afterAll(() => registerProjectFeatures([]));

test("quickservicets eject tenancy writes features/tenancy/, which replaces the native", () => {
  expect(lines).toContain("features/tenancy/ now replaces the tenancy native.");
  expect(readFileSync(join(root, "features/tenancy/index.ts"), "utf8")).toContain('from "@quickservicets/core"');
  const config = resolveConfig({ database: memoryAdapter(), tenancy: {} } as ServiceConfig, {});
  expect(config.features.find((feature) => feature.key === "tenancy")?.definition).toBe(ejected.default as never);
});

runTenantIsolationSuite({ adapter: "memory", strategy: "schema", name: "ejected" });
