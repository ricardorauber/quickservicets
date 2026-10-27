import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./index.ts";
import { memoryAdapter } from "./adapters/memory.ts";
import { defineFeature, registerNative, unregisterNative } from "./features.ts";
import { decodeEnvelopeData, encodeEnvelopeData, localTransport, transportOrigin } from "./http/socket-transport.ts";
import { inProcessTransports, runSocketTransportContract } from "./testing/socket-transport-contract.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";

const hub = inProcessTransports();
runSocketTransportContract(() => hub.transport(), { name: "in-process", drop: (transport) => (transport as ReturnType<typeof hub.transport>).drop() });
runSocketTransportContract(() => localTransport(), { name: "local", crossProcess: false });

describe("envelopes", () => {
  test("binary frames travel as base64 and origins name the host, the process and a random part", () => {
    expect(encodeEnvelopeData("hi")).toEqual({ data: "hi" });
    const bytes = new Uint8Array([0, 255, 7]);
    expect(encodeEnvelopeData(bytes)).toEqual({ data: "AP8H", binary: true });
    expect(decodeEnvelopeData({ data: "AP8H", binary: true })).toEqual(bytes);
    expect(transportOrigin()).toMatch(new RegExp(`^.+:${process.pid}:[0-9a-f]{8}$`));
    expect(transportOrigin()).not.toBe(transportOrigin());
  });
});

describe("the contract", () => {
  test("it fails for a transport that drops except", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qs-transport-contract-"));
    try {
      const contract = join(import.meta.dir, "testing/socket-transport-contract.ts");
      writeFileSync(
        join(dir, "broken.test.ts"),
        `import { inProcessTransports, runSocketTransportContract } from ${JSON.stringify(contract)};
const hub = inProcessTransports();
runSocketTransportContract(() => {
  const inner = hub.transport();
  return { ...inner, publish: (envelope) => inner.publish({ ...envelope, except: undefined }) };
}, { name: "broken" });
`,
      );
      const run = Bun.spawnSync(["bun", "test", join(dir, "broken.test.ts")], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const output = `${run.stdout}${run.stderr}`;
      expect(run.exitCode).not.toBe(0);
      expect(output).toContain("(fail) SocketTransport contract: broken > except is delivered with the envelope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the local transport with several workers", () => {
  const registered: string[] = [];
  const running: TestApp[] = [];
  afterEach(async () => {
    for (const app of running.splice(0)) await app.stop();
    for (const key of registered.splice(0)) unregisterNative(key);
  });

  test("startup warns once that other workers will not receive room messages", async () => {
    registerNative(defineFeature({ key: "socket-user", docs: { summary: "Uses sockets." }, enabledByDefault: true, after: ["realtime"], setup: (ctx) => void ctx.feature("realtime").sockets() }));
    registered.push("socket-user");
    const database = Object.assign(memoryAdapter(), { kind: "custom" });
    for (let index = 0; index < 2; index++) running.push(await startTestApp({ config: { realtime: {}, server: { workers: 2 } }, database: database as never }));
    const warnings = running.flatMap((app) => app.logs.filter((entry) => String(entry.message).startsWith("realtime.websockets uses the local transport")));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toBe(
      "realtime.websockets uses the local transport; sockets on other workers will not receive room messages; configure realtime.websockets.transport",
    );
  });
});
