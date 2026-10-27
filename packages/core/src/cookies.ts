/** Whether the configuration resolved last runs in production, so session cookies are `Secure`. */
let secureCookies = false;

/** Records whether the resolved configuration runs in production; `resolveConfig` calls it. */
export function configureCookies(production: boolean): void {
  secureCookies = production;
}

/** What `sessionCookie` takes besides the name and value. */
export interface SessionCookieOptions {
  /** Seconds the browser keeps the cookie. */
  maxAge: number;
  /** The cookie's path (default `/`). */
  path?: string;
  /** The `SameSite` attribute (default `Lax`). */
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * The `Set-Cookie` value of a session cookie: `HttpOnly`, `Path=/`, `SameSite=Lax` unless given, `Max-Age`, and
 * `Secure` when the service runs in production. Providers use it for every session cookie they set.
 */
export function sessionCookie(name: string, value: string, options: SessionCookieOptions): string {
  const parts = [`${name}=${value}`, "HttpOnly", `Path=${options.path ?? "/"}`, `SameSite=${options.sameSite ?? "Lax"}`, `Max-Age=${Math.floor(options.maxAge)}`];
  if (secureCookies || options.sameSite === "None") parts.push("Secure");
  return parts.join("; ");
}

/** The value of one cookie of a `Cookie` header, or undefined without it. */
export function cookieValue(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}
