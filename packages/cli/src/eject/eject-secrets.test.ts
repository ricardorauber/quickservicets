import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { refreshSecrets, setSecretsClock } from "@quickservicets/core";
import { mockHttp } from "@quickservicets/core/testing";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { eject } from "./eject.ts";

const example = join(import.meta.dir, "../../../../examples/minimal/secrets");
const read = (path: string) => readFileSync(join(example, path), "utf8");
afterEach(() => setSecretsClock(undefined));

test("quickservicets eject secrets turns the native into features/secrets/ and the example keeps resolving and rotating", async () => {
  const config = read("quickservicets.config.ts");
  const root = createLinkedProject({ "quickservicets.config.ts": config, "vault/local-vault.ts": read("vault/local-vault.ts"), "local-vault.json": read("local-vault.json") });
  const lines = await eject(root, "secrets");
  expect(lines).toContain("features/secrets/ now replaces the secrets native.");
  const files: Record<string, string> = {
    "quickservicets.config.ts": config,
    "vault/local-vault.ts": read("vault/local-vault.ts"),
    "local-vault.json": read("local-vault.json"),
    "endpoints/partner/get.ts": read("endpoints/partner/get.ts"),
    "endpoints/payments/get.ts": read("endpoints/payments/get.ts"),
    "secrets/api-key": "ejected-payments-key\n",
  };
  for (const file of readdirSync(join(root, "features/secrets"))) files[`features/secrets/${file}`] = readFileSync(join(root, "features/secrets", file), "utf8");
  expect(existsSync(join(root, "features/secrets/index.ts"))).toBe(true);
  let now = Date.parse("2026-11-02T10:00:00.000Z");
  setSecretsClock(() => now);
  const mock = mockHttp();
  mock.service("payments").on("GET", "/balance").reply(200, { balance: 1 });
  mock.service("partner").on("GET", "/status").reply(200, { status: "ok" });
  const service = await startTestService({ files, env: { DATABASE_URL: "postgres://app:pw@localhost:5432/app" } });
  try {
    await service.fetch("/payments");
    expect(mock.calls.at(-1)!.headers["x-api-key"]).toBe("ejected-payments-key");
    writeFileSync(join(service.root, "local-vault.json"), JSON.stringify({ partner: { token: "ejected-token-v2" } }));
    now += 60_000;
    await refreshSecrets();
    await service.fetch("/partner");
    expect(mock.calls.at(-1)!.headers.authorization).toBe("Bearer ejected-token-v2");
  } finally {
    mock.restore();
    await service.stop();
  }
});
