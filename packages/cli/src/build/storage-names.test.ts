import { expect, test } from "bun:test";
import { createLinkedProject, createProject } from "../testing/project.ts";
import { parseEntities } from "../entities/parse-entities.ts";
import { build } from "./build.ts";

test("a file entity uses its @storage", () => {
  const [document] = parseEntities(
    createProject({ "entities/Document.ts": 'import type { File } from "@quickservice/core";\n/** @storage archive */\nexport type Document = File & { pages?: number }' }),
  );
  expect(document!.storageName).toBe("archive");
});

test("an unknown storage fails the build naming entity and storage", async () => {
  const root = createLinkedProject({
    "quickservice.config.ts": 'import { defineConfig, memoryAdapter } from "@quickservice/core";\nexport default defineConfig({ database: memoryAdapter() });\n',
    "entities/Document.ts": 'import type { File } from "@quickservice/core";\n/** @storage archive */\nexport type Document = File & { pages?: number }',
  });
  await expect(build(root)).rejects.toThrow('entity Document uses storage "archive"');
});

test("@storage on a regular entity fails", () => {
  expect(() => parseEntities(createProject({ "entities/User.ts": "/** @storage s3 */\nexport type User = { name: string }" }))).toThrow(
    "invalid @storage: User is not a file entity",
  );
});
