import { expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, localServicesPlan, type DevOptions } from "@quickservicets/core";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/dev");
const read = (path: string) => readFileSync(join(example, path), "utf8");
const sources = ["quickservicets.config.ts", "entities/Post.ts", "entities/Attachment.ts", "queues/notify.ts", "endpoints/posts/[id]/notify/post.ts"];

test("quickservicets eject dev turns the native into features/dev/ and the example keeps its services and tests", async () => {
  const files: Record<string, string> = Object.fromEntries(sources.map((path) => [path, read(path)]));
  const root = createLinkedProject({ ...files, "package.json": JSON.stringify({ name: "minimal-dev" }) });
  try {
    const lines = await eject(root, "dev");
    expect(lines).toContain("features/dev/ now replaces the dev native.");
    for (const file of readdirSync(join(root, "features/dev"))) files[`features/dev/${file}`] = readFileSync(join(root, "features/dev", file), "utf8");
    expect(Object.keys(files)).toContain("features/dev/index.ts");
    const config = await loadConfig(root, {});
    const dev = config.features.find((feature) => feature.key === "dev")!;
    expect(dev.project).toBe(true);
    const plan = localServicesPlan(config as never, dev.options as unknown as DevOptions, root);
    expect(plan.services.map((service) => service.name)).toEqual(["database", "minio"]);
    const service = await startTestService({ files });
    try {
      const post = (await (await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Ejected" }) })).json()) as { id: string };
      expect((await service.fetch(`/posts/${post.id}/notify`, { method: "POST" })).status).toBe(200);
    } finally {
      await service.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
