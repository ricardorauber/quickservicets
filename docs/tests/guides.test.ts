import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerProjectFeatures } from "../../packages/core/src/features.ts";
import { build } from "../../packages/cli/src/build/build.ts";
import { startTestService } from "../../packages/cli/src/testing/service.ts";
import { createLinkedProject } from "../../packages/cli/src/testing/project.ts";
import { extractSnippets } from "../scripts/checks.ts";

const content = join(import.meta.dir, "../src/content/docs");

/** The project files of a guide: its titled snippets, without the generated ones and the tests. */
function projectOf(page: string): Record<string, string> {
  const snippets = extractSnippets(page, readFileSync(join(content, page), "utf8"));
  return Object.fromEntries(
    snippets.filter((snippet) => snippet.title && !snippet.title.startsWith(".generated/") && !snippet.title.startsWith("tests/")).map((snippet) => [snippet.title!, `${snippet.code}\n`]),
  );
}

afterEach(() => registerProjectFeatures([]));

test("the features/greeting sample of the project features guide builds and runs", async () => {
  const files = projectOf("guides/project-features.md");
  expect(Object.keys(files).sort()).toEqual([
    "entities/Post.ts",
    "features/greeting/commands.ts",
    "features/greeting/endpoints/greetings/random/get.ts",
    "features/greeting/entities/Greeting.ts",
    "features/greeting/hooks/stamp.ts",
    "features/greeting/index.ts",
    "features/greeting/jobs/count.ts",
    "features/greeting/middleware.ts",
    "features/greeting/request.ts",
    "greetings/formal.ts",
    "quickservice.config.ts",
  ]);
  const root = createLinkedProject(files);
  const summary = await build(root, {});
  expect(summary.fromFeatures).toEqual({ endpoints: 1, hooks: 1, jobs: 1 });
  expect(summary.buildSteps?.map((step) => step.key)).toEqual(["greeting"]);
  expect(readFileSync(join(root, ".generated/greeting/greetings.json"), "utf8")).toBe('["formal"]');
  expect(JSON.parse(readFileSync(join(root, ".generated/openapi.json"), "utf8")).paths["/greetings/today"].get.summary).toBe("Today's greeting");
  expect(readFileSync(join(root, ".generated/jobs.ts"), "utf8")).toContain('"greeting/count"');

  const service = await startTestService({ files, env: { QS_GREETING_TEXT: "Hey" } });
  try {
    const today = await service.fetch("/greetings/today");
    expect(today.headers.get("x-greeting")).toBe("on");
    expect(await today.json()).toEqual({ text: "Hey!", known: ["formal"] });
    expect(await (await service.fetch("/greetings/static/css/site.css")).json()).toEqual({ file: "css/site.css" });
    expect(((await (await service.fetch("/greetings/random")).json()) as { text: string }).text).toStartWith("Hello, you (request ");
    const post = await service.fetch("/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "First" }) });
    expect(await post.json()).toMatchObject({ title: "First", greeting: "Good day" });
    expect((await service.fetch("/greetings")).status).toBe(200);
  } finally {
    await service.stop();
  }
  expect(existsSync(service.root)).toBe(false);
});
