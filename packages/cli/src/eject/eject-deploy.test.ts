import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { run } from "../run.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/deploy");
const read = (path: string) => readFileSync(join(example, path), "utf8");

test("quickservicets eject deploy turns the native into features/deploy/; the example builds its targets and keeps its tests", async () => {
  const files: Record<string, string> = { "quickservicets.config.ts": read("quickservicets.config.ts"), "entities/Post.ts": read("entities/Post.ts") };
  const root = createLinkedProject({ ...files, "package.json": JSON.stringify({ name: "minimal-deploy" }) });
  try {
    const lines = await eject(root, "deploy");
    expect(lines).toContain("features/deploy/ now replaces the deploy native.");
    for (const file of readdirSync(join(root, "features/deploy"))) files[`features/deploy/${file}`] = readFileSync(join(root, "features/deploy", file), "utf8");
    const out: string[] = [];
    const err: string[] = [];
    expect(await run(["build"], { log: (line) => out.push(line), error: (line) => err.push(line) }, root)).toBe(0);
    expect(out).toContain("Override: features/deploy replaces the deploy native");
    expect(existsSync(join(root, "dist/server/server.js"))).toBe(true);
    const service = await startTestService({ files });
    try {
      expect((await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Ejected" }) })).status).toBe(201);
    } finally {
      await service.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
