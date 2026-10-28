import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { memoryAdapter, reloadTls, requestTlsRestart, startService, TlsReloader, type LogEntry, type ReloadedTls, type RunningService, type ServiceConfig } from "@quickservicets/core";
import { createTestCertificates, type TestCertificate } from "@quickservicets/core/testing";
import { startTestService, type TestService } from "../testing/service.ts";

const certs = createTestCertificates();

/** A folder holding `server.crt` and `server.key`, copied from a test pair. */
function folder(pair: TestCertificate = certs.server) {
  const dir = mkdtempSync(join(tmpdir(), "qs-reload-"));
  copyFileSync(pair.cert, join(dir, "server.crt"));
  copyFileSync(pair.key, join(dir, "server.key"));
  copyFileSync(certs.ca.cert, join(dir, "ca.crt"));
  return dir;
}
/** Replaces the files of a folder with another pair, through a rename as tools that renew certificates do. */
function replace(dir: string, pair: TestCertificate) {
  copyFileSync(pair.cert, join(dir, "server.crt.next"));
  copyFileSync(pair.key, join(dir, "server.key.next"));
  renameSync(join(dir, "server.crt.next"), join(dir, "server.crt"));
  renameSync(join(dir, "server.key.next"), join(dir, "server.key"));
}

/** The organization of the certificate a new connection to the port is served. */
const served = (port: number) =>
  new Promise<string>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, servername: "localhost", ca: certs.ca.certPem }, () => {
      resolve(String(socket.getPeerCertificate().subject.O));
      socket.end();
    });
    socket.on("error", (error: Error) => resolve(`error ${error.message}`));
  });
const until = async (check: () => boolean | Promise<boolean>, tries = 200) => {
  for (let attempt = 0; attempt < tries && !(await check()); attempt++) await Bun.sleep(20);
};
const capture = () => {
  const entries: LogEntry[] = [];
  const push = (entry: LogEntry) => void entries.push(entry);
  return { entries, logger: { info: push, warn: push, error: push } };
};

const running: TestService[] = [];
const services: RunningService[] = [];
afterEach(async () => {
  for (const service of running.splice(0)) await service.stop();
  for (const service of services.splice(0)) await service.stop();
  delete (globalThis as { reloadLogs?: unknown }).reloadLogs;
});

describe("file hashing and intervals", () => {
  test("a changed file is noticed by content, also through a swapped symbolic link, and an unchanged one is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-reload-links-"));
    for (const [version, pair] of [["v1", certs.server], ["v2", certs.server2]] as const) {
      writeFileSync(join(dir, `${version}.crt`), pair.certPem);
      writeFileSync(join(dir, `${version}.key`), pair.keyPem);
    }
    symlinkSync(join(dir, "v1.crt"), join(dir, "tls.crt"));
    symlinkSync(join(dir, "v1.key"), join(dir, "tls.key"));
    const applied: ReloadedTls[] = [];
    const { logger } = capture();
    const reloader = new TlsReloader({ tls: { cert: join(dir, "tls.crt"), key: join(dir, "tls.key"), reloadInterval: "50ms" }, logger, apply: (next) => void applied.push(next) });
    expect(await reloader.check()).toEqual({ changed: false, applied: false });
    // Kubernetes swaps a symbolic link to a new folder; the content behind the path changed.
    symlinkSync(join(dir, "v2.crt"), join(dir, "tls.crt.tmp"));
    symlinkSync(join(dir, "v2.key"), join(dir, "tls.key.tmp"));
    renameSync(join(dir, "tls.crt.tmp"), join(dir, "tls.crt"));
    renameSync(join(dir, "tls.key.tmp"), join(dir, "tls.key"));
    reloader.start();
    try {
      await until(() => applied.length > 0);
      expect(applied[0]!.info.subject).toContain("Tests 2");
      expect(await reloader.check()).toEqual({ changed: false, applied: false });
    } finally {
      reloader.stop();
    }
  });
});

describe("SIGHUP and the setup API", () => {
  test("SIGHUP applies replaced files at once, and reloadTls() resolves changed and applied", async () => {
    const dir = folder();
    const { entries, logger } = capture();
    const handlers = new Map<string, () => void>();
    const log = spyOn(console, "log").mockImplementation(() => {});
    let service: RunningService | undefined;
    try {
      service = await startService({
        projectConfig: { database: memoryAdapter(), logger, server: { port: 0 as never, tls: { cert: join(dir, "server.crt"), key: join(dir, "server.key"), reloadInterval: "1h" } } } as ServiceConfig,
        models: [],
        crudRoutes: [],
        endpoints: [],
        hooks: new Map(),
        env: { QS_SERVER_PORT: String(freePort()) },
        process: { once: (signal: string, handler: () => void) => void handlers.set(signal, handler), exit: () => {} } as never,
      });
    } finally {
      log.mockRestore();
    }
    services.push(service!);
    const port = service!.port;
    expect(await served(port)).toBe("QuickService.ts Tests");
    replace(dir, certs.server2);
    process.emit("SIGHUP" as never);
    await until(async () => (await served(port)) === "QuickService.ts Tests 2");
    expect(await served(port)).toBe("QuickService.ts Tests 2");
    expect(entries.find((entry) => entry.message === "tls.reloaded")).toMatchObject({ subject: expect.stringContaining("Tests 2") });
    replace(dir, certs.server);
    expect(await reloadTls()).toEqual({ changed: true, applied: true });
    expect(await served(port)).toBe("QuickService.ts Tests");
  });
});

describe("validation before applying", () => {
  test("a key that does not match keeps the old certificate and logs once until the files change again", async () => {
    const dir = folder();
    const { entries, logger } = capture();
    let applied = 0;
    const reloader = new TlsReloader({ tls: { cert: join(dir, "server.crt"), key: join(dir, "server.key") }, logger, apply: () => void applied++ });
    copyFileSync(certs.server2.key, join(dir, "server.key"));
    expect(await reloader.check()).toEqual({ changed: true, applied: false });
    expect(await reloader.check()).toEqual({ changed: true, applied: false });
    const failures = entries.filter((entry) => entry.message === "tls.reload.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toBe("Invalid server.tls: the key does not match the certificate");
    expect(JSON.stringify(failures)).not.toContain("BEGIN");
    copyFileSync(certs.server2.cert, join(dir, "server.crt"));
    expect(await reloader.check()).toEqual({ changed: true, applied: true });
    expect(applied).toBe(1);
  });
});

describe("applying on both server paths and the restart fallback", () => {
  const config = (dir: string, extra = "") => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({
  database: memoryAdapter(),
  logger: { info() {}, warn() {}, error() {} },
  server: { tls: { cert: ${JSON.stringify(join(dir, "server.crt"))}, key: ${JSON.stringify(join(dir, "server.key"))}, reloadInterval: "100ms" } },
  ${extra}
});
`;

  test("Bun.serve: new connections get the new certificate while a long request on an old connection completes", async () => {
    const dir = folder();
    const service = await startTestService({ files: { "quickservicets.config.ts": config(dir), "endpoints/slow/get.ts": "export default async () => { await Bun.sleep(600); return { done: true }; };\n" } });
    running.push(service);
    const { port } = await service.listen();
    const slow = fetch(`https://localhost:${port}/slow`, { tls: { ca: certs.ca.certPem } } as RequestInit).then((response) => response.json());
    await Bun.sleep(50);
    replace(dir, certs.server2);
    await until(async () => (await served(port)) === "QuickService.ts Tests 2");
    expect(await served(port)).toBe("QuickService.ts Tests 2");
    expect(await slow).toEqual({ done: true });
  });

  test("node:tls: a replaced client CA refuses clients it does not sign", async () => {
    const dir = folder();
    const service = await startTestService({ files: { "quickservicets.config.ts": config(dir, `security: { mtls: { ca: [${JSON.stringify(join(dir, "ca.crt"))}] } },`) } });
    running.push(service);
    const { port } = await service.listen();
    // A new connection each time, presenting the billing certificate, which only the first CA signs.
    const call = () =>
      new Promise<string>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port, servername: "localhost", ca: certs.ca.certPem, cert: certs.billing.certPem, key: certs.billing.keyPem }, () => {
          socket.write("GET /health HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n");
        });
        let text = "";
        socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
        socket.on("end", () => resolve(text.startsWith("HTTP/1.1") ? text.split(" ")[1]! : "refused"));
        socket.on("error", () => resolve("refused"));
      });
    expect(await call()).toBe("404");
    copyFileSync(certs.otherCa.cert, join(dir, "ca.crt"));
    await until(async () => (await call()) === "refused");
    expect(await call()).toBe("refused");
  });

  test("a runtime refusing the certificates restarts the worker: it drains, then exits, later workers after the earlier ones", async () => {
    const { logger } = capture();
    const restarts: string[] = [];
    const reloader = new TlsReloader({ tls: { cert: certs.server.cert, key: certs.server.key }, logger, apply: () => { throw new Error("refused"); }, restart: () => void restarts.push("restart") });
    (reloader as unknown as { hashes: Map<string, string> }).hashes.set(certs.server.cert, "old");
    expect(await reloader.check()).toEqual({ changed: true, applied: false });
    expect(restarts).toEqual(["restart"]);

    const exits: { code: number; at: number }[] = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    const startedAt = Date.now();
    try {
      for (const index of ["0", "1"]) {
        const dir = folder();
        const service = await startService({
          projectConfig: { database: memoryAdapter(), logger, lifecycle: { stopTimeout: "200ms" }, server: { tls: { cert: join(dir, "server.crt"), key: join(dir, "server.key") } } } as ServiceConfig,
          models: [],
          crudRoutes: [],
          endpoints: [],
          hooks: new Map(),
          env: { QS_SERVER_PORT: String(freePort()), QS_WORKER_INDEX: index },
          process: { once: () => {}, exit: (code: number) => void exits.push({ code, at: Date.now() - startedAt }) } as never,
        });
        services.push(service!);
        requestTlsRestart();
        if (index === "0") {
          await until(() => exits.length === 1);
          expect(exits[0]!.code).toBe(0);
        }
      }
    } finally {
      log.mockRestore();
    }
    await until(() => exits.length === 2, 200);
    expect(exits[1]!.code).toBe(0);
    expect(exits[1]!.at - exits[0]!.at).toBeGreaterThanOrEqual(2000);
  }, 20_000);
});

describe("disabled watching", () => {
  test("with watch false or PEM text no timer runs, and SIGHUP logs tls.reload.skipped", async () => {
    const intervals = spyOn(globalThis, "setInterval");
    try {
      const { logger } = capture();
      const off = new TlsReloader({ tls: { cert: certs.server.cert, key: certs.server.key, watch: false }, logger, apply: () => {} });
      off.start();
      const text = new TlsReloader({ tls: { cert: certs.server.certPem, key: certs.server.keyPem }, logger, apply: () => {} });
      text.start();
      expect(off.watching).toBe(false);
      expect(text.watching).toBe(false);
      expect(intervals).not.toHaveBeenCalled();
    } finally {
      intervals.mockRestore();
    }
    const { entries, logger } = capture();
    expect(await reloadTls(logger)).toEqual({ changed: false, applied: false });
    expect(entries.map((entry) => entry.message)).toEqual(["tls.reload.skipped"]);
  });
});

/** A port nothing listens on now. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}
