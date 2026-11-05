import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
