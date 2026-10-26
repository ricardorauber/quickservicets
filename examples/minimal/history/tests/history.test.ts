import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const entry of readdirSync(join(root, "entities"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type Version = { version: number; operation: string; actor: string; record: Record<string, unknown> };

test("every write of a document is a version over both history routes, without its sensitive note; drafts have no history route", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const { id } = (await (await service.fetch("/documents", send("POST", { title: "Plan", body: "v1", secretNote: "s" }))).json()) as { id: string };
    await service.fetch(`/documents/${id}`, send("PATCH", { body: "v2" }));
    await service.fetch(`/documents/${id}`, { method: "DELETE" });
    const list = (await (await service.fetch(`/documents/${id}/history`)).json()) as { total: number; data: Version[] };
    expect(list.total).toBe(3);
    expect(list.data.map((version) => [version.version, version.operation])).toEqual([
      [3, "delete"],
      [2, "update"],
      [1, "create"],
    ]);
    expect(list.data[0]!.record).toMatchObject({ id, body: "v2" });
    const first = (await (await service.fetch(`/documents/${id}/history/1`)).json()) as Version;
    expect([first.operation, first.actor, first.record.body]).toEqual(["create", "system", "v1"]);
    for (const version of [...list.data, first]) expect(Object.keys(version.record)).not.toContain("secretNote");
    const draft = (await (await service.fetch("/drafts", send("POST", { text: "idea" }))).json()) as { id: string };
    expect((await service.fetch(`/drafts/${draft.id}/history`)).status).toBe(404);
  } finally {
    await service.stop();
  }
});

test("quickservicets history prune --dry-run prints a count per entity", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const cli = join(service.root, "node_modules/@quickservicets/cli/src/index.ts");
    const result = Bun.spawnSync(["bun", cli, "history", "prune", "--dry-run"], { cwd: service.root, env: { ...process.env, QS_HISTORY_RETENTION: "30d" }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toMatch(/^Document: \d+ versions would be deleted$/m);
  } finally {
    await service.stop();
  }
});
