import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const entry of readdirSync(join(root, "entities"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const send = (method: string, body?: unknown) => ({ method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type Version = { entityId: string; version: number; operation: string; record: Record<string, unknown> };

test("every write of a document stores a version without its sensitive note; drafts keep none", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const { id } = (await (await service.fetch("/documents", send("POST", { title: "Plan", body: "v1", secretNote: "s" }))).json()) as { id: string };
    await service.fetch(`/documents/${id}`, send("PATCH", { body: "v2" }));
    await service.fetch(`/documents/${id}`, { method: "DELETE" });
    await service.fetch("/drafts", send("POST", { text: "idea" }));
    const repos = service.repos as unknown as Record<string, { query(): { all(): Promise<Version[]> } } | undefined>;
    const versions = (await repos.documentHistory!.query().all()).sort((a, b) => a.version - b.version);
    expect(versions.map((version) => [version.version, version.operation])).toEqual([
      [1, "create"],
      [2, "update"],
      [3, "delete"],
    ]);
    expect(versions[2]!.record).toMatchObject({ id, body: "v2" });
    for (const version of versions) expect(Object.keys(version.record)).not.toContain("secretNote");
    expect(repos.draftHistory).toBeUndefined();
  } finally {
    await service.stop();
  }
});
