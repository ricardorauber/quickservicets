import { expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { run } from "../run.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/connections");
const read = (path: string) => readFileSync(join(example, path), "utf8");

test("quickservicets eject connections turns the native into features/connections/; the example builds and keeps its tests", async () => {
  const files: Record<string, string> = { "quickservicets.config.ts": read("quickservicets.config.ts"), "entities/Post.ts": read("entities/Post.ts") };
  const root = createLinkedProject({ ...files, "package.json": JSON.stringify({ name: "minimal-connections" }) });
  try {
    const lines = await eject(root, "connections");
    expect(lines).toContain("features/connections/ now replaces the connections native.");
    for (const file of readdirSync(join(root, "features/connections"))) files[`features/connections/${file}`] = readFileSync(join(root, "features/connections", file), "utf8");
    const out: string[] = [];
    const err: string[] = [];
    expect(await run(["build"], { log: (line) => out.push(line), error: (line) => err.push(line) }, root)).toBe(0);
    expect(out).toContain("Override: features/connections replaces the connections native");
    const service = await startTestService({ files });
    try {
      expect((await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Ejected pools" }) })).status).toBe(201);
    } finally {
      await service.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
