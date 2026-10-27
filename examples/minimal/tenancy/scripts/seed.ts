import { mkdirSync } from "node:fs";

/**
 * Creates the example's tenants: acme on the free plan (a schema of data.db) and globex on the enterprise plan (its
 * own file in data/). Run it after `quickservicets migrate`, with `bun run seed`.
 */
mkdirSync("data", { recursive: true });
const tenants: [id: string, plan: string][] = [
  ["acme", "free"],
  ["globex", "enterprise"],
];
for (const [id, plan] of tenants) {
  const result = Bun.spawnSync(["bun", "x", "quickservicets", "tenants", "create", id, "--plan", plan], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
