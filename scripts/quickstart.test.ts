import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readTopics } from "../packages/cli/src/agents/topics.ts";
import { ROOT } from "./agents.ts";

/** A step of the quickstart: the lines of a `bash` block, or a file written from a code block that starts with `// <path>`. */
type Step = { kind: "commands"; lines: string[] } | { kind: "file"; path: string; content: string };

/** The code blocks of a topic, in order, as steps. */
function stepsOf(markdown: string): Step[] {
  const steps: Step[] = [];
  const blocks = markdown.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm);
  for (const [, language, body = ""] of blocks) {
    const path = /^\/\/ (\S+\.ts)\n/.exec(body)?.[1];
    if (language === "bash") steps.push({ kind: "commands", lines: body.split("\n").filter((line) => line.trim() !== "") });
    else if (path) steps.push({ kind: "file", path, content: body });
  }
  return steps;
}

const CLI = join(ROOT, "packages/cli/src/index.ts");
const folder = mkdtempSync(join(tmpdir(), "quickservicets-quickstart-"));
let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;

afterAll(async () => {
  server?.kill("SIGTERM");
  await server?.exited;
  rmSync(folder, { recursive: true, force: true });
});

/** A free port for the service. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

/** Links the framework packages of this repository where `bun install` would install them from npm. */
function linkPackages(project: string): void {
  mkdirSync(join(project, "node_modules/@quickservicets"), { recursive: true });
  mkdirSync(join(project, "node_modules/.bin"), { recursive: true });
  symlinkSync(join(ROOT, "packages/core"), join(project, "node_modules/@quickservicets/core"), "dir");
  symlinkSync(join(ROOT, "packages/cli"), join(project, "node_modules/@quickservicets/cli"), "dir");
  symlinkSync(CLI, join(project, "node_modules/.bin/quickservicets"));
}

/** Waits until the service prints that it listens, failing with its output after a minute. */
async function waitForListening(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  const decoder = new TextDecoder();
  let output = "";
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 60_000;
  while (!output.includes("listening on")) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => undefined)]);
    if (!chunk || chunk.done) throw new Error(`The service did not start:\n${output}${await new Response(child.stderr).text()}`);
    output += decoder.decode(chunk.value);
  }
  reader.releaseLock();
}

test("following the quickstart topic literally builds a service that answers GET /tasks", async () => {
  const quickstart = readTopics().find((topic) => topic.name === "quickstart")!;
  const steps = stepsOf(quickstart.markdown);
  expect(steps.map((step) => (step.kind === "file" ? step.path : step.lines[0]))).toEqual([
    "bunx quickservicets init my-api --db sqlite",
    "entities/Task.ts",
    "bun run build",
    "bun run quickservicets migration add CreateTasks",
    "bun run dev",
    "curl -X POST localhost:3000/tasks -H \"content-type: application/json\" -d '{\"title\":\"Write the docs\"}'",
    'curl -g "localhost:3000/tasks?where[done][eq]=false&sort=-createdAt"',
    "bun run quickservicets migration list --json",
  ]);

  const port = freePort();
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port) };
  let cwd = folder;
  const outputs = new Map<string, string>();
  for (const step of steps) {
    if (step.kind === "file") {
      mkdirSync(dirname(join(cwd, step.path)), { recursive: true });
      writeFileSync(join(cwd, step.path), step.content);
      continue;
    }
    for (const line of step.lines) {
      if (line.startsWith("cd ")) {
        cwd = join(cwd, line.slice(3).trim());
      } else if (line === "bun install") {
        linkPackages(cwd);
      } else if (line === "bun run dev") {
        server = Bun.spawn(["bun", "run", "dev"], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        await waitForListening(server);
      } else {
        const command = line.startsWith("bunx quickservicets ") ? ["bun", CLI, ...line.split(" ").slice(2)] : ["sh", "-c", line.replaceAll("localhost:3000", `localhost:${port}`)];
        const result = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(`${line} failed:\n${result.stdout.toString()}${result.stderr.toString()}`);
        outputs.set(line, result.stdout.toString());
      }
    }
  }

  const response = await fetch(`http://localhost:${port}/tasks`);
  expect(response.status).toBe(200);
  const list = (await response.json()) as { data: { title: string; done: boolean }[]; total: number };
  expect(list.total).toBe(1);
  expect(list.data[0]).toMatchObject({ title: "Write the docs", done: false });
  expect(JSON.parse(outputs.get('curl -g "localhost:3000/tasks?where[done][eq]=false&sort=-createdAt"')!).data[0].title).toBe("Write the docs");
  expect(JSON.parse(outputs.get("bun run quickservicets migration list --json")!)).toEqual({ ok: true, migrations: [{ id: expect.stringMatching(/_CreateTasks$/), status: "applied", schemas: [] }] });
  expect(JSON.parse(outputs.get("bun run quickservicets migrate --json --yes")!)).toMatchObject({ ok: true, applied: [] });
}, 180_000);
