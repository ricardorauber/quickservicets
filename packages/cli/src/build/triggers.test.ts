import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { eject } from "../eject/eject.ts";
import { registerProjectFeatures } from "@quickservicets/core";
import { emitTrigger } from "@quickservicets/core/testing";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

afterEach(() => registerProjectFeatures([]));

const CONFIG = `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), triggers: {}, events: {}, history: {} });
`;
const IMAGE = "/** @history */\nexport type Image = { key: string };\n";
const NEW_IMAGE = `import { testSource, trigger } from "@quickservicets/core";
export default trigger<{ key: string }>({
  source: testSource(),
  async handle({ event, repos, log }) {
    log.info("new image", { key: event.data.key });
    await repos.images.create({ key: event.data.key });
  },
});
`;
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};

describe("trigger files", () => {
  test("a file's path names its trigger in TriggerNames, a feature's trigger is <key>/<path>, and a file without trigger() fails the build", async () => {
    const root = createLinkedProject({
      "quickservicets.config.ts": CONFIG,
      "entities/Image.ts": IMAGE,
      "triggers/uploads/new-image.ts": NEW_IMAGE,
      "features/sync/index.ts": 'import { defineFeature } from "@quickservicets/core";\nexport default defineFeature({ key: "sync", enabledByDefault: true });\n',
      "features/sync/triggers/pull.ts": 'import { testSource, trigger } from "@quickservicets/core";\nexport default trigger({ source: testSource(), handle() {} });\n',
    });
    await build(root);
    const types = readFileSync(join(root, ".generated/types.ts"), "utf8");
    expect(types).toContain("interface TriggerNames {");
    expect(types).toContain('"uploads/new-image": TriggerDataOf<typeof import("../triggers/uploads/new-image.ts").default>;');
    expect(types).toContain('"sync/pull": TriggerDataOf<typeof import("../features/sync/triggers/pull.ts").default>;');
    const bad = createLinkedProject({ "quickservicets.config.ts": CONFIG, "triggers/bad.ts": "export default () => {};\n" });
    expect((await failure(() => build(bad))).message).toBe("triggers/bad.ts: must default-export trigger(...)");
  });

  test("without trigger files the types file has no TriggerNames", async () => {
    const root = createLinkedProject({ "quickservicets.config.ts": CONFIG });
    await build(root);
    expect(readFileSync(join(root, ".generated/types.ts"), "utf8")).not.toContain("TriggerNames");
  });
});

describe("emitTrigger", () => {
  test("runs the handler with the event data, working repos and a log carrying trigger and eventId, writing as job:trigger/<name>", async () => {
    const service = await startTestService({ files: { "quickservicets.config.ts": CONFIG, "entities/Image.ts": IMAGE, "triggers/uploads/new-image.ts": NEW_IMAGE } });
    try {
      const outcome = await emitTrigger("uploads/new-image" as never, { key: "a.png" } as never);
      expect(outcome).toMatchObject({ status: "completed", trigger: "uploads/new-image", eventId: expect.any(String) });
      const images = (await (await service.fetch("/images")).json()) as { data: { id: string; key: string }[] };
      expect(images.data.map((image) => image.key)).toEqual(["a.png"]);
      const history = (await (await service.fetch(`/images/${images.data[0]!.id}/history`)).json()) as { data: { actor: string }[] };
      expect(history.data[0]!.actor).toBe("job:trigger/uploads/new-image");
    } finally {
      await service.stop();
    }
  });
});

describe("push routes", () => {
  test("a CloudEvents trigger's route answers pushes and is absent from /openapi.json", async () => {
    const service = await startTestService({
      files: {
        "quickservicets.config.ts": CONFIG,
        "entities/Image.ts": IMAGE,
        "triggers/stored.ts": 'import { cloudEvents, trigger } from "@quickservicets/core";\nexport default trigger<{ name: string }>({ source: cloudEvents({ type: "storage.*" }), handle: ({ event, repos }) => repos.images.create({ key: event.data.name }) });\n',
      },
    });
    try {
      const pushed = await service.fetch("/_triggers/stored", { method: "POST", headers: { "content-type": "application/json", "ce-specversion": "1.0", "ce-id": "1", "ce-source": "/bucket", "ce-type": "storage.object.created" }, body: JSON.stringify({ name: "b.png" }) });
      expect(pushed.status).toBe(204);
      expect(((await (await service.fetch("/images")).json()) as { total: number }).total).toBe(1);
      const paths = Object.keys(((await (await service.fetch("/openapi.json")).json()) as { paths: Record<string, unknown> }).paths);
      expect(paths.some((path) => path.startsWith("/_triggers"))).toBe(false);
    } finally {
      await service.stop();
    }
  });
});

describe("override files", () => {
  test("a project file triggers/<key>/<path>.ts replaces the trigger a project feature ships, with an override line", async () => {
    const shipped = 'import { testSource, trigger } from "@quickservicets/core";\nexport default trigger({ source: testSource(), handle: () => { throw new Error("shipped"); } });\n';
    const root = createLinkedProject({
      "quickservicets.config.ts": CONFIG,
      "features/sync/index.ts": 'import { defineFeature } from "@quickservicets/core";\nexport default defineFeature({ key: "sync", enabledByDefault: true });\n',
      "features/sync/triggers/sync.ts": shipped,
      "triggers/sync/sync.ts": 'import { testSource, trigger } from "@quickservicets/core";\nexport default trigger({ source: testSource(), handle() {} });\n',
    });
    const summary = await build(root);
    expect(summary.overrides).toContain("Override: triggers/sync/sync.ts replaces features/sync/triggers/sync.ts from sync");
    expect(readFileSync(join(root, ".generated/types.ts"), "utf8")).toContain('"sync/sync": TriggerDataOf<typeof import("../triggers/sync/sync.ts").default>;');
  });
});

describe("eject", () => {
  test("the ejected native replaces triggers and the example's triggers keep working", async () => {
    const example = join(import.meta.dir, "../../../../examples/minimal/triggers");
    const files: Record<string, string> = {};
    for (const entry of readdirSync(example, { recursive: true, withFileTypes: true })) {
      const path = relative(example, join(entry.parentPath, entry.name));
      if (entry.isFile() && path.endsWith(".ts") && !/^(node_modules|\.generated|tests)\//.test(path)) files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
    const root = createLinkedProject(files);
    const lines = await eject(root, "triggers");
    expect(lines).toContain("features/triggers/ now replaces the triggers native.");
    for (const entry of readdirSync(join(root, "features/triggers"), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
    const service = await startTestService({ files });
    try {
      const outcome = await emitTrigger("new-upload" as never, { key: "ejected.png" } as never);
      expect(outcome.status).toBe("completed");
      expect(((await (await service.fetch("/uploads")).json()) as { total: number }).total).toBe(1);
    } finally {
      await service.stop();
    }
  });
});
