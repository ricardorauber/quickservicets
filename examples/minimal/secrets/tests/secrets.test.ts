import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshSecrets, setSecretsClock } from "@quickservicets/core";
import { mockHttp, type HttpMock } from "@quickservicets/core/testing";
import { startTestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const KEY = "example-payments-key";

/** The example's files, with the seeded API key, and an endpoint that fails with the partner token in its message. */
const files = () => ({
  "quickservicets.config.ts": read("quickservicets.config.ts"),
  "vault/local-vault.ts": read("vault/local-vault.ts"),
  "local-vault.json": read("local-vault.json"),
  "endpoints/partner/get.ts": read("endpoints/partner/get.ts"),
  "endpoints/payments/get.ts": read("endpoints/payments/get.ts"),
  "endpoints/leak/get.ts": 'import { secrets } from "@quickservicets/core";\nexport default async () => {\n  throw new Error(`partner refused ${await secrets.get("local://partner#token")}`);\n};\n',
  "secrets/api-key": `${KEY}\n`,
});
const env = { DATABASE_URL: "postgres://app:example-password@localhost:5432/app" };

let now = Date.parse("2026-11-02T10:00:00.000Z");
let mock: HttpMock;
beforeEach(() => {
  setSecretsClock(() => now);
  mock = mockHttp();
  mock.service("payments").on("GET", "/balance").reply(200, { balance: 120 });
  mock.service("partner").on("GET", "/status").reply(200, { status: "ok" });
});
afterEach(() => mock.restore());
afterAll(() => setSecretsClock(undefined));

test("references resolve at startup, values are masked and the partner token rotates without a restart", async () => {
  const service = await startTestService({ files: files(), env });
  try {
    expect(await (await service.fetch("/payments")).json()).toEqual({ balance: 120 });
    expect(mock.calls.at(-1)!.headers["x-api-key"]).toBe(KEY);
    expect(await (await service.fetch("/partner")).json()).toEqual({ status: "ok" });
    expect(mock.calls.at(-1)!.headers.authorization).toBe("Bearer partner-token-v1");

    const failed = (await (await service.fetch("/leak")).json()) as { error: { details?: { stack?: string } } };
    expect(failed.error.details?.stack).toContain("partner refused [secret]");
    expect(JSON.stringify(failed)).not.toContain("partner-token-v1");

    writeFileSync(join(service.root, "local-vault.json"), JSON.stringify({ partner: { token: "partner-token-v2" } }));
    now += 60_000;
    await refreshSecrets();
    await service.fetch("/partner");
    expect(mock.calls.at(-1)!.headers.authorization).toBe("Bearer partner-token-v2");
  } finally {
    await service.stop();
  }
});

test("a reference that cannot be resolved stops startup naming it, never a value", async () => {
  const { "secrets/api-key": _key, ...withoutKey } = files();
  await expect(startTestService({ files: withoutKey, env })).rejects.toThrow("http.services.payments.auth.apiKey.value: file://secrets/api-key (not found)");
});

test("quickservicets secrets check prints ok lines, and failed: not found once the key file is gone", async () => {
  const service = await startTestService({ files: files(), env });
  try {
    const cli = join(service.root, "node_modules/@quickservicets/cli/src/index.ts");
    const check = () => Bun.spawnSync(["bun", cli, "secrets", "check"], { cwd: service.root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    const ok = check();
    const lines = ok.stdout.toString();
    expect(ok.exitCode).toBe(0);
    expect(lines).toContain("database.url env://DATABASE_URL ok");
    expect(lines).toContain("http.services.payments.auth.apiKey.value file://secrets/api-key ok");
    expect(lines).toContain("http.services.partner.auth.bearer local://partner#token ok");
    rmSync(join(service.root, "secrets/api-key"));
    const failing = check();
    expect(failing.exitCode).toBe(1);
    expect(failing.stdout.toString()).toContain("http.services.payments.auth.apiKey.value file://secrets/api-key failed: not found");
    for (const value of [KEY, "partner-token-v1", "example-password"]) expect(`${failing.stdout}${failing.stderr}${lines}`).not.toContain(value);
  } finally {
    await service.stop();
  }
});
