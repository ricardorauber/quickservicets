import type { ServiceRequest } from "../public.ts";
import { AuthError, type AuthProvider, type AuthResult } from "./api.ts";

/** Marks the providers `testAuth()` returns, which never run in production. */
export const TEST_PROVIDER = Symbol.for("quickservicets.auth.test");

/** What `testAuth()` takes. */
export interface TestAuthOptions {
  /** The header carrying the test user (default `x-test-user`). */
  header?: string;
  /** The provider's name (default `test`). */
  name?: string;
}

/**
 * Parses `<id>[;roles=a,b][;tenant=<id>][;session=<id>][;scopes=a,b][;email=<e-mail>][;name=<name>]`, or throws an
 * `AuthError` for a value without an id or with an unknown part.
 */
export function parseTestUser(value: string): AuthResult {
  const [id = "", ...parts] = value.split(";").map((part) => part.trim());
  if (id === "" || id.includes("=")) throw new AuthError("malformed test user");
  const result: AuthResult = { user: { id }, method: "test" };
  const list = (text: string) => text.split(",").map((item) => item.trim()).filter(Boolean);
  for (const part of parts) {
    const at = part.indexOf("=");
    const key = at < 0 ? part : part.slice(0, at);
    const text = at < 0 ? "" : part.slice(at + 1);
    if (key === "roles") result.user.roles = list(text);
    else if (key === "tenant" && text !== "") result.tenant = { id: text };
    else if (key === "session" && text !== "") result.sessionId = text;
    else if (key === "scopes") result.scopes = list(text);
    else if (key === "email") result.user.email = text;
    else if (key === "name") result.user.name = text;
    else throw new AuthError(`unknown test user part ${key}`);
  }
  return result;
}

/**
 * An authentication provider for tests, reading `x-test-user: <id>[;roles=a,b][;tenant=<id>]` (and optionally
 * `;session=<id>`, `;scopes=a,b`, `;email=…` and `;name=…`) with the method `test`. A service with `production` true
 * refuses to start with it.
 */
export function testAuth(options: TestAuthOptions = {}): AuthProvider {
  const header = (options.header ?? "x-test-user").toLowerCase();
  const provider: AuthProvider = {
    name: options.name ?? "test",
    credentials: { headers: [header] },
    challenge: 'Test realm="test"',
    authenticate(req: ServiceRequest) {
      const value = req.headers.get(header);
      return value === null ? null : parseTestUser(value);
    },
  };
  Object.defineProperty(provider, TEST_PROVIDER, { value: true });
  return provider;
}

/** Whether a provider is one `testAuth()` returned. */
export function isTestProvider(provider: AuthProvider): boolean {
  return (provider as unknown as Record<symbol, unknown>)[TEST_PROVIDER] === true;
}
