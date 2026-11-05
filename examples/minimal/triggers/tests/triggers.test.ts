import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emitTrigger } from "@quickservicets/core/testing";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = () => ({
  "quickservicets.config.ts": read("quickservicets.config.ts"),
  "entities/Upload.ts": read("entities/Upload.ts"),
  "triggers/new-upload.ts": read("triggers/new-upload.ts"),
});

test("an emitted event of new-upload creates an Upload record", async () => {
  const service = await startTestService({ files: files() });
  try {
    const outcome = await emitTrigger("new-upload" as never, { key: "photos/a.png" } as never);
    expect(outcome.status).toBe("completed");
    const uploads = (await (await service.fetch("/uploads")).json()) as { data: { key: string }[] };
    expect(uploads.data.map((upload) => upload.key)).toEqual(["photos/a.png"]);
  } finally {
    await service.stop();
  }
});
