import type { ClientCertificate } from "../public.ts";
import type { AuthProvider } from "./api.ts";

/** What `certificateAuth` takes. */
export interface CertificateAuthOptions {
  /** The user a client certificate stands for, or null when it stands for none. */
  user(client: ClientCertificate): { id: string; roles?: string[] } | null | Promise<{ id: string; roles?: string[] } | null>;
  /** The provider's name (default `certificate`). */
  name?: string;
}

/**
 * An authentication provider for callers with a client certificate (`req.client`, verified by `security.mtls` or
 * forwarded by a trusted proxy): `user(client)` maps it to a user with the method `certificate`, so `@auth` and
 * `@roles` work for service identities, like `user: (c) => ({ id: c.subject.commonName!, roles: ["service"] })`.
 */
export function certificateAuth(options: CertificateAuthOptions): AuthProvider {
  if (typeof options?.user !== "function") throw new Error("certificateAuth() needs a user(client) function");
  return {
    name: options.name ?? "certificate",
    credentials: { clientCertificate: true },
    async authenticate(req) {
      const client = req.client;
      if (!client) return null;
      const user = await options.user(client);
      return user ? { user: { id: user.id, roles: user.roles ?? [] }, method: "certificate" } : null;
    },
  };
}
