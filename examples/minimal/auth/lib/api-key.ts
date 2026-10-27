import { timingSafeEqual } from "node:crypto";
import { AuthError, env, type AuthProvider } from "@quickservicets/core";

const same = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** A project-written provider: the `x-api-key` header must equal the `API_KEY` variable, and signs in an editor. */
export function apiKeyProvider(): AuthProvider {
  return {
    name: "api-key",
    credentials: { headers: ["x-api-key"] },
    challenge: 'ApiKey header="x-api-key"',
    authenticate(req) {
      const expected = env.API_KEY;
      if (!expected) throw new AuthError("API_KEY is not set");
      if (!same(req.headers.get("x-api-key") ?? "", expected)) throw new AuthError("unknown key");
      return { user: { id: "api-client", roles: ["editor"] }, method: "apiKey" };
    },
  };
}
