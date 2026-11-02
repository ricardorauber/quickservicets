import { describe, expect, test } from "bun:test";
import "./index.ts";
import { providerRegistry, resolveReference, type SecretProvider } from "./features/secrets/index.ts";
import { defineSecretProvider, parseSecretReference, SecretAccessError, SecretNotFoundError } from "./secret-references.ts";
import { checkSecretProvider, runSecretProviderContract, testSecretProvider } from "./testing/index.ts";

const resolveWith = (provider: SecretProvider, text: string, retries = 2) => {
  const registry = providerRegistry();
  registry.add(provider, "the test");
  return resolveReference(registry, parseSecretReference(text), { timeout: 1000, retries, backoff: 1 });
};

describe("definition validation", () => {
  test("an invalid scheme throws naming it; a valid definition is returned", () => {
    expect(() => defineSecretProvider({ name: "x", schemes: ["HTTP"], resolve: () => ({ value: "v" }) })).toThrow('Invalid secret provider x: the scheme "HTTP" must match');
    expect(() => defineSecretProvider({ name: "x", schemes: ["https"], resolve: () => ({ value: "v" }) })).toThrow("Invalid secret provider x: the scheme https is reserved for connection URLs");
    expect(() => defineSecretProvider({ name: "", schemes: ["x"], resolve: () => ({ value: "v" }) })).toThrow("name must be a non-empty text");
    expect(() => defineSecretProvider({ name: "x", schemes: ["x"], resolve: "no" as never })).toThrow("resolve must be a function");
    const provider = defineSecretProvider({ name: "x", schemes: ["x"], resolve: () => ({ value: "v" }), transport: "sdk" });
    expect(provider.name).toBe("x");
  });
});

describe("key extraction from values and JSON", () => {
  test("#key reads values; without a key one entry is taken and several fail", async () => {
    const provider = testSecretProvider({ db: { values: { user: "u-name", pass: "p-word" } }, single: { values: { token: "only-token" } }, json: JSON.stringify({ user: "json-user" }) });
    expect((await resolveWith(provider, "test://db#pass")).value).toBe("p-word");
    await expect(resolveWith(provider, "test://db")).rejects.toThrow("test://db: the secret has several keys; add #<key>");
    expect((await resolveWith(provider, "test://single")).value).toBe("only-token");
    expect((await resolveWith(provider, "test://json#user")).value).toBe("json-user");
    await expect(resolveWith(provider, "test://db#missing")).rejects.toThrow("no key missing");
  });
});

describe("error classes and retry rules", () => {
  test("SecretNotFoundError is not retried and holds no value; a generic error is retried twice", async () => {
    const provider = testSecretProvider({ api: "the-api-value" });
    const missing = (await resolveWith(provider, "test://missing").catch((error: Error) => error)) as Error;
    expect(missing.message).toBe("test://missing: not found");
    expect(provider.calls).toEqual(["test://missing"]);
    provider.fail("api", new SecretAccessError("test://api"));
    await expect(resolveWith(provider, "test://api")).rejects.toThrow("test://api: access denied");
    expect(provider.calls.filter((call) => call === "test://api").length).toBe(1);
    provider.fail("api", new Error("connection reset"));
    await expect(resolveWith(provider, "test://api")).rejects.toThrow("connection reset");
    expect(provider.calls.filter((call) => call === "test://api").length).toBe(4);
    expect(new SecretNotFoundError(parseSecretReference("vault://kv/db")).message).toBe("vault://kv/db: not found");
  });
});

describe("the test provider", () => {
  test("resolves its entries, rotates with set and keeps versions", async () => {
    const provider = testSecretProvider({ db: "a" });
    expect((await resolveWith(provider, "test://db")).value).toBe("a");
    provider.set("db", "b");
    expect(await resolveWith(provider, "test://db")).toMatchObject({ value: "b", version: "2" });
    expect(await resolveWith(provider, "test://db?version=1")).toMatchObject({ value: "a", version: "1" });
    await expect(resolveWith(provider, "test://db?version=3")).rejects.toThrow("test://db?version=3: not found");
    expect(testSecretProvider({}, "local").schemes).toEqual(["local"]);
  });

  test("a pinned ?version=3 reaches the provider", async () => {
    const seen: (string | undefined)[] = [];
    const provider = defineSecretProvider({ name: "v", schemes: ["v"], resolve: (reference) => (seen.push(reference.version), { value: "pinned-value", version: reference.version ?? "1" }) });
    expect(await resolveWith(provider, "v://kv/db?version=3")).toMatchObject({ value: "pinned-value", version: "3" });
    expect(seen).toEqual(["3"]);
  });
});

const fixtures = {
  value: { reference: "test://db", value: "db-value-2" },
  key: { reference: "test://kv#pass", value: "kv-password" },
  version: { reference: "test://db?version=1", value: "db-value-1", version: "1" },
  missing: "test://missing",
  denied: "test://denied",
  slow: "test://slow",
};
const createTestProvider = () => {
  const provider = testSecretProvider({ db: "db-value-1", kv: { values: { user: "kv-user", pass: "kv-password" } } });
  provider.set("db", "db-value-2");
  provider.fail("denied", new SecretAccessError("test://denied"));
  return provider;
};

describe("the contract suite against good and broken providers", () => {
  runSecretProviderContract(createTestProvider, { name: "testSecretProvider", fixtures });

  test("a provider that ignores the signal fails the abort check", async () => {
    const good = createTestProvider();
    const deaf = defineSecretProvider({
      name: "deaf",
      schemes: ["test"],
      resolve: (reference, context) => (reference.path === "slow" ? new Promise<never>(() => {}) : good.resolve(reference, context)),
    });
    const failures = await checkSecretProvider(() => deaf, { fixtures });
    expect(failures).toEqual([{ check: "aborts its request when the signal aborts", message: "the provider ignores the abort signal: its resolution was still pending 1 second after the abort" }]);
  });

  test("a provider leaving a timer after close, or calling fetch directly, fails", async () => {
    const good = createTestProvider();
    const timers: ReturnType<typeof setInterval>[] = [];
    const leaking = () => {
      let timer: ReturnType<typeof setInterval> | undefined;
      return defineSecretProvider({
        name: "leaking",
        schemes: ["test"],
        resolve: async (reference, context) => {
          if (!timer) timers.push((timer = setInterval(() => {}, 60_000)));
          if (reference.path === "db" && !reference.version) await fetch("data:text/plain,x");
          return good.resolve(reference, context);
        },
        close: () => {},
      });
    };
    const failures = await checkSecretProvider(leaking, { fixtures });
    for (const timer of timers) clearInterval(timer);
    expect(failures.map((failure) => failure.check)).toEqual(["leaves no timers after close()", "calls HTTP only through a registered service"]);
    const sdk = defineSecretProvider({ ...good, name: "sdk", transport: "sdk", resolve: async (reference, context) => (await fetch("data:text/plain,x"), good.resolve(reference, context)) });
    expect((await checkSecretProvider(() => sdk, { fixtures })).map((failure) => failure.check)).not.toContain("calls HTTP only through a registered service");
  });
});
