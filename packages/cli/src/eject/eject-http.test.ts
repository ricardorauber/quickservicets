import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/http");

/** The files of a project folder, as `startTestService` takes them, without generated and installed files. */
function filesOf(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = relative(root, join(entry.parentPath, entry.name));
    if (!entry.isFile() || /^(node_modules|\.generated|tests|scripts)\//.test(path) || !path.endsWith(".ts")) continue;
    files[path] = readFileSync(join(entry.parentPath, entry.name), "utf8");
  }
  return files;
}

const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ text: "Ejected and still calling." }) });
const saved = process.env.QUOTES_URL;
process.env.QUOTES_URL = `http://127.0.0.1:${upstream.port}`;
afterAll(() => {
  if (saved === undefined) delete process.env.QUOTES_URL;
  else process.env.QUOTES_URL = saved;
  upstream.stop(true);
});

test("quickservicets eject http turns the native into features/http/, and the example keeps calling its upstream", async () => {
  const root = createLinkedProject(filesOf(example));
  const lines = await eject(root, "http");
  expect(lines).toContain("features/http/ now replaces the http native.");
  expect(existsSync(join(root, "features/http/index.ts"))).toBe(true);
  expect(readFileSync(join(root, "features/http/client.ts"), "utf8")).toContain('from "@quickservicets/core"');
  const service = await startTestService({ files: filesOf(root) });
  try {
    const response = await service.fetch("/quote");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { quote: string }).quote).toBe("Ejected and still calling.");
  } finally {
    await service.stop();
  }
});
