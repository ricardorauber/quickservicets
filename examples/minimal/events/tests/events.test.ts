import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "@quickservice/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(root, "quickservice.config.ts"), "utf8") };
  for (const dir of ["entities", "features"]) {
    for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("user writes are audited after the commit, and an in-transaction listener refuses a bad user", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const created = (await (await service.fetch("/users", json({ name: "Ada", email: "ada@example.com" }))).json()) as { id: string };
    await service.fetch(`/users/${created.id}`, { ...json({ name: "Ada L." }), method: "PATCH" });
    await service.fetch(`/users/${created.id}`, { method: "DELETE" });
    const refused = await service.fetch("/users", json({ name: "Bob", email: "nope" }));
    expect(refused.status).toBe(400);

    const audit = (service.repos as unknown as { auditEntries: { query(): { all(): Promise<{ type: string; changed: string[] }[]> } } }).auditEntries;
    for (let attempt = 0; attempt < 100 && (await audit.query().all()).length < 3; attempt++) await Bun.sleep(10);
    const entries = await audit.query().all();
    expect(entries.map((entry) => entry.type).sort()).toEqual(["user.created", "user.deleted", "user.updated"]);
    expect(entries.find((entry) => entry.type === "user.updated")!.changed).toEqual(["name"]);
    const users = (service.repos as unknown as { users: { query(): { all(): Promise<unknown[]> } } }).users;
    expect(await users.query().all()).toEqual([]);
  } finally {
    await service.stop();
  }
});
