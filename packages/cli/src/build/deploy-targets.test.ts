import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMachinePlatform, defaultPlatform, loadConfig } from "@quickservicets/core";
import { run } from "../run.ts";
import { createLinkedProject } from "../testing/project.ts";
import { deployTargetOf, formatSize } from "./deploy.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const project = (config: string, files: Record<string, string> = {}) => {
  const root = createLinkedProject({ "package.json": JSON.stringify({ name: "@acme/blog" }), "quickservicets.config.ts": config, "entities/Post.ts": "export type Post = { title: string };\n", ...files });
  roots.push(root);
  return root;
};

const MEMORY = `import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({});\n`;

const cli = async (args: string[], root: string) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { log: (line) => out.push(line), error: (line) => err.push(line) }, root);
  return { code, out, err };
};

describe("options, defaults and precedence", () => {
  test("each target has its default platform", () => {
    expect(defaultPlatform("lambda")).toBe("linux-arm64");
    expect(defaultPlatform("azure-functions")).toBe("linux-x64");
    expect(defaultPlatform("cloud-run")).toBe("linux-x64");
    expect(defaultPlatform("server")).toBe(buildMachinePlatform());
    expect(defaultPlatform("binary")).toBe(buildMachinePlatform());
  });

  test("the flag wins over QS_DEPLOY_TARGET, which wins over the config, which wins over server", async () => {
    const root = project(`import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ deploy: { target: "binary" } });\n`);
    expect(deployTargetOf(await loadConfig(root, {}), undefined)).toBe("binary");
    expect(deployTargetOf(await loadConfig(root, { QS_DEPLOY_TARGET: "lambda" }), undefined)).toBe("lambda");
    expect(deployTargetOf(await loadConfig(root, { QS_DEPLOY_TARGET: "lambda" }), "cloud-run")).toBe("cloud-run");
    const bare = project(MEMORY);
    expect(deployTargetOf(await loadConfig(bare, {}), undefined)).toBe("server");
  });

  test("an unknown target exits 1 naming the targets", async () => {
    const result = await cli(["build", "--target", "vercel"], project(MEMORY));
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["Unknown deploy target vercel; use server, binary, lambda, azure-functions or cloud-run"]);
  });
});

describe("output folders and summary lines", () => {
  test("without a deploy key the build writes dist/server/ and prints its line; --target binary writes dist/binary/", async () => {
    const root = project(MEMORY);
    mkdirSync(join(root, "dist/server"), { recursive: true });
    writeFileSync(join(root, "dist/server/stale.txt"), "old");
    const server = await cli(["build"], root);
    expect(server.code).toBe(0);
    const line = server.out.find((entry) => entry.startsWith("Target "))!;
    expect(line).toMatch(/^Target server: dist\/server\/ \(\d+(\.\d)? (B|KB|MB)\)$/);
    expect(readdirSync(join(root, "dist/server")).sort()).toEqual(["assets", "server.js", "server.js.map"]);
    const binary = await cli(["build", "--target", "binary"], root);
    expect(binary.out.find((entry) => entry.startsWith("Target "))).toStartWith("Target binary: dist/binary/ (");
    expect(existsSync(join(root, "dist/binary"))).toBe(true);
  }, 180_000);

  test("sizes print in bytes, kilobytes or megabytes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  test("the server target starts from a folder holding only its output and answers", async () => {
    const root = project(MEMORY);
    expect((await cli(["build"], root)).code).toBe(0);
    const alone = mkdtempSync(join(tmpdir(), "qs-server-target-"));
    roots.push(alone);
    cpSync(join(root, "dist/server"), join(alone, "dist/server"), { recursive: true });
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop(true);
    const child = Bun.spawn([process.execPath, "dist/server/server.js"], { cwd: alone, env: { PATH: process.env.PATH ?? "", PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
    try {
      const reader = child.stdout.getReader();
      let text = "";
      while (!/listening on (\S+)/.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      const url = /listening on (\S+)/.exec(text)![1]!;
      const created = await fetch(`${url}/posts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Bundled" }) });
      expect(created.status).toBe(201);
      expect(((await (await fetch(`${url}/posts`)).json()) as { total: number }).total).toBe(1);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 60_000);
});

describe("function mode", () => {
  const files = {
    "jobs/reports/daily.ts": 'import { job } from "@quickservicets/core";\nexport default job("0 6 * * *", async () => {});\n',
    "queues/notify.ts": 'import { queue } from "@quickservicets/core";\nexport default queue<{ id: string }>(async () => {});\n',
  };
  const config = `import { defineConfig, postgresAdapter } from "@quickservicets/core";\nexport default defineConfig({ database: postgresAdapter({ url: "postgres://localhost/app" }), server: { workers: 2 }, queues: {} });\n`;

  test("lambda warns for the workers, each scheduled job and each database queue", async () => {
    const result = await cli(["build", "--target", "lambda"], project(config, files));
    expect(result.code).toBe(0);
    expect(result.err).toContain("Warning: server.workers is ignored on lambda");
    expect(result.err).toContain("Warning: jobs/reports/daily runs only when the platform invokes it (see the deploy guide)");
    expect(result.err).toContain("Warning: queues/notify needs a platform trigger (an SQS or Service Bus trigger) to be consumed");
    // The server target warns about none of them.
    const server = await cli(["build"], project(config, files));
    expect(server.err.filter((line) => line.includes("platform"))).toEqual([]);
  }, 180_000);

  test("a ws.ts route fails the build on a function target", async () => {
    const root = project(`import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ realtime: { websockets: {} } });\n`, {
      "endpoints/chat/ws.ts": 'import { defineSocket } from "@quickservicets/core";\nexport default defineSocket({ message() {} });\n',
    });
    const result = await cli(["build", "--target", "azure-functions"], root);
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["endpoints/chat/ws.ts cannot run on azure-functions; WebSockets need a server target"]);
  });
});

describe("the disabled native", () => {
  test("deploy: false refuses targets other than server", async () => {
    const root = project(`import { defineConfig } from "@quickservicets/core";\nexport default defineConfig({ deploy: false });\n`);
    const result = await cli(["build", "--target", "lambda"], root);
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["deploy is disabled (deploy: false in quickservicets.config.ts)"]);
    const plain = await cli(["build"], root);
    expect(plain.code).toBe(0);
    expect(plain.out.some((line) => line.startsWith("Target "))).toBe(false);
  });
});
