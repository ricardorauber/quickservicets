import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService } from "../../packages/cli/src/testing/service.ts";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/history");
const guide = readFileSync(join(content, "guides/history.md"), "utf8");
const recipe = readFileSync(join(content, "recipes/audit-trail.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

/** The example's files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservice.config.ts": readFileSync(join(example, "quickservice.config.ts"), "utf8") };
  for (const entry of readdirSync(join(example, "entities"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(example, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

describe("the history guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["entities/Document.ts", "entities/Draft.ts", "quickservice.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## What history stores, and when",
      "inside the write's own transaction",
      "## Tables",
      "document_history",
      "## Actors",
      "## Covered entities and fields",
      "## Routes and permissions",
      "## Retention and pruning",
      "kept forever by default",
      "LGPD",
      "GDPR",
      "## Customization",
      "beforeVersion",
      "store",
      "quickservice eject history",
      "## The cost on writes",
      "## Removing history",
      "migration add",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("it is in the Guides sidebar, and the configuration and events guides link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    expect(readFileSync(join(content, "guides/configuration.md"), "utf8")).toContain("(/guides/history/)");
    expect(readFileSync(join(content, "guides/events.md"), "utf8")).toContain("(/guides/history/)");
    expect(guide).toContain("(/recipes/audit-trail/)");
  });
});

describe("the audit trail recipe", () => {
  test("applied to the example, it keeps versions for a year and restricts the history routes to the owner and auditors", async () => {
    const samples = titledSamples(recipe);
    expect([...samples.keys()].sort()).toEqual(["entities/Document.ts", "hooks/auditReader.ts", "quickservice.config.ts"]);
    expect(samples.get("quickservice.config.ts")).toContain('retention: "365d"');
    const signIn = `import { defineFeature } from "@quickservice/core";
export default defineFeature({
  key: "signin",
  middleware: [{ stage: "handler", run: (req, _res, next) => { const id = req.headers.get("x-user"); if (id) (req as { user?: unknown }).user = { id, roles: (req.headers.get("x-roles") ?? "").split(",") }; return next(); } }],
});
`;
    const files: Record<string, string> = { ...exampleFiles(), ...Object.fromEntries(samples), "features/signin/index.ts": signIn };
    files["quickservice.config.ts"] = files["quickservice.config.ts"]!.replace("events: {},", "events: {},\n  signin: {},");
    const service = await startTestService({ files });
    try {
      const created = await service.fetch("/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Plan", body: "v1", owner: "ana" }) });
      const { id } = (await created.json()) as { id: string };
      const history = (headers: Record<string, string>) => service.fetch(`/documents/${id}/history`, { headers });
      expect((await history({})).status).toBe(401);
      expect((await history({ "x-user": "bob" })).status).toBe(403);
      expect((await service.fetch(`/documents/${id}/history/1`, { headers: { "x-user": "bob" } })).status).toBe(403);
      expect((await history({ "x-user": "ana" })).status).toBe(200);
      expect((await history({ "x-user": "carla", "x-roles": "auditor" })).status).toBe(200);
    } finally {
      await service.stop();
    }
  });
});
