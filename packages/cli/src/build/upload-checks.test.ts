import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUploadCheck, createFile, registerProjectFeatures } from "@quickservicets/core";
import { fileSamples } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

afterEach(() => registerProjectFeatures([]));

const running: TestService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
});

const state = globalThis as unknown as { checkCalls: string[]; checkLogs: { message: string; [key: string]: unknown }[]; spools: string[]; streamsEqual?: boolean };

/** A feature whose check rejects files containing EVIL, says SLOW is unavailable and fails on CRASH. */
const SCANNER = `import { addUploadCheck, defineFeature, UploadCheckUnavailableError, UploadRejectedError } from "@quickservicets/core";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
const state = globalThis as unknown as { checkCalls: string[]; spools: string[]; streamsEqual?: boolean };
export default defineFeature({
  key: "scanner",
  setup() {
    addUploadCheck({
      name: "scanner",
      async check(file) {
        state.checkCalls.push(\`scanner:\${file.entity}:\${file.field ?? "file"}\`);
        if (file.size > 16 * 1024 * 1024) {
          state.spools = readdirSync(tmpdir()).filter((name) => name.startsWith("quickservicets-upload-check-"));
          const first = new Uint8Array(await new Response(file.stream()).arrayBuffer());
          const second = new Uint8Array(await new Response(file.stream()).arrayBuffer());
          state.streamsEqual = first.length === file.size && Buffer.compare(Buffer.from(first), Buffer.from(second)) === 0;
          return;
        }
        const text = new TextDecoder().decode(await file.bytes());
        if (text.includes("EVIL")) throw new UploadRejectedError("Malware found");
        if (text.includes("SLOW")) throw new UploadCheckUnavailableError("scanner timed out");
        if (text.includes("CRASH")) throw new Error("scanner crashed");
      },
    });
  },
});
`;

async function start(extra = "") {
  state.checkCalls = [];
  state.checkLogs = [];
  state.spools = [];
  state.streamsEqual = undefined;
  const dir = mkdtempSync(join(tmpdir(), "quickservicets-upload-checks-"));
  const service = await startTestService({
    files: {
      "quickservicets.config.ts": `import { defineConfig, localStorage, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  storage: { default: localStorage({ dir: ${JSON.stringify(dir)} }) },
  files: { maxSize: "30MB", accept: ["*/*"], checks: [{ name: "project", check: (file) => void (globalThis as unknown as { checkCalls: string[] }).checkCalls.push(\`project:\${file.entity}\`) }] ${extra} },
  logger: { info: (entry) => globalThis.checkLogs?.push(entry), warn: (entry) => globalThis.checkLogs?.push(entry), error: (entry) => globalThis.checkLogs?.push(entry) },
  scanner: {},
});
`,
      "features/scanner/index.ts": SCANNER,
      "entities/Post.ts": 'import type { Media } from "@quickservicets/core";\nexport type Post = { title: string; attachments?: Media[] };\n',
    },
  });
  running.push(service);
  return { service, dir };
}

const stored = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
const upload = (service: TestService, path: string, form: FormData) => service.fetch(path, { method: "POST", body: form });
const fileOf = (text: string, name = "a.png") => new File([fileSamples.png, text], name, { type: "image/png" });

describe("checks on uploads", () => {
  test("a rejected file answers 400 with the reason and stores nothing; a clean one is stored after the project's check", async () => {
    const { service, dir } = await start();
    const rejected = new FormData();
    rejected.set("file", fileOf("EVIL", "secret-name.png"));
    const answer = await upload(service, "/media", rejected);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: { code: string; details: unknown } }).error).toMatchObject({ code: "VALIDATION_ERROR", details: [{ field: "file", message: "Malware found" }] });
    expect(stored(dir)).toBe(0);
    const clean = new FormData();
    clean.set("file", fileOf("fine"));
    expect((await upload(service, "/media", clean)).status).toBe(201);
    expect(stored(dir)).toBe(1);
    expect(state.checkCalls).toEqual(["project:Media", "scanner:Media:file", "project:Media", "scanner:Media:file"]);
    const log = state.checkLogs.find((entry) => entry.message === "upload.rejected")!;
    expect(log).toMatchObject({ entity: "Media", field: "file", check: "scanner", reason: "Malware found" });
    expect(JSON.stringify(log)).not.toContain("secret-name");
  });

  test("a multipart entity create with a rejected second part stores neither file and creates no post", async () => {
    const { service, dir } = await start();
    const form = new FormData();
    form.set("title", "with files");
    form.append("attachments", fileOf("fine", "one.png"));
    form.append("attachments", fileOf("EVIL", "two.png"));
    const answer = await upload(service, "/posts", form);
    expect(answer.status).toBe(400);
    expect(((await answer.json()) as { error: { details: unknown } }).error.details).toEqual([{ field: "attachments[1]", message: "Malware found" }]);
    expect(stored(dir)).toBe(0);
    expect(await (service.repos as unknown as { posts: { query(): { toArray(): Promise<unknown[]> } } }).posts.query().toArray()).toEqual([]);
  });

  test("an unavailable check answers 503 SCANNER_UNAVAILABLE with Retry-After: 30; a failing one 500, logged", async () => {
    const { service } = await start();
    const slow = new FormData();
    slow.set("file", fileOf("SLOW"));
    const unavailable = await upload(service, "/media", slow);
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("30");
    expect(((await unavailable.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "SCANNER_UNAVAILABLE", message: "Upload check scanner is unavailable" });
    const crash = new FormData();
    crash.set("file", fileOf("CRASH"));
    expect((await upload(service, "/media", crash)).status).toBe(500);
    expect(state.checkLogs.some((entry) => entry.message === "upload.check.failed" && entry.check === "scanner")).toBe(true);
    expect(state.checkLogs.some((entry) => entry.message === "upload.check.unavailable")).toBe(true);
  });

  test("a 20 MB file is spooled to a temporary file while checked, removed after; stream() twice gives the same bytes", async () => {
    const { service } = await start();
    const form = new FormData();
    form.set("file", new File([fileSamples.png, new Uint8Array(20 * 1024 * 1024)], "big.png", { type: "image/png" }));
    expect((await upload(service, "/media", form)).status).toBe(201);
    expect(state.spools.length).toBeGreaterThan(0);
    expect(state.streamsEqual).toBe(true);
    const left = readdirSync(tmpdir()).filter((name) => state.spools.includes(name));
    expect(left).toEqual([]);
  }, 30_000);
});

describe("createFile and registration", () => {
  test("createFile passes the checks; addUploadCheck after setup throws", async () => {
    await start();
    await expect(createFile("Media", { body: new Uint8Array([...fileSamples.png, ...new TextEncoder().encode("EVIL")]), filename: "x.png" })).rejects.toMatchObject({ status: 400, details: [{ field: "file", message: "Malware found" }] });
    expect(() => addUploadCheck({ name: "late", check: () => {} })).toThrow("addUploadCheck must be called during setup");
  });
});
