import { expect, test } from "bun:test";
import { startTestService } from "@quickservice/cli/testing";

test("a post created over HTTP is listed", async () => {
  const service = await startTestService({
    files: {
      "quickservice.config.ts": 'import { defineConfig, memoryAdapter } from "@quickservice/core";\nexport default defineConfig({ database: memoryAdapter() });\n',
      "entities/Post.ts": "export type Post = { title: string };\n",
    },
  });
  try {
    const created = await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Hello" }) });
    expect(created.status).toBe(201);
    const listed = (await (await service.fetch("/posts")).json()) as { data: { title: string }[] };
    expect(listed.data.map((post) => post.title)).toEqual(["Hello"]);
  } finally {
    await service.stop();
  }
});
