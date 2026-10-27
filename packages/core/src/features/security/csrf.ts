import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookieValue, HttpError, normalizeOrigin, OriginMatcher, ownOriginReader, peerAddress, resolveOption, safeLog, type HandlerMiddleware, type Logger, type OptionFunction, type ServiceRequest } from "../public.ts";

/** The `csrf` item's options. */
export interface CsrfOptions {
  enabled: boolean;
  mode: "origin" | "token";
  origins: readonly string[];
  cookie: string;
  header: string;
}

/** The methods that never change state, which the checks let through. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The 403 of a cross-site request riding on a session cookie. */
export const csrfRejected = () => new HttpError(403, "Cross-site request rejected", { code: "CSRF_REJECTED" });

/** Whether two texts are equal, compared in constant time. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** What the CSRF middleware needs besides its options. */
export interface CsrfContext {
  /** The origins of `security.cors.origins` while CORS is on (a function computes them per request). */
  corsOrigins: readonly string[] | OptionFunction<string[]> | undefined;
  proxy: { enabled?: boolean; trust?: readonly string[] } | undefined;
  production: boolean;
  /** Whether the checks apply to a request's route: false for routes tagged `@csrf off`. */
  appliesTo: (req: ServiceRequest) => boolean;
  logger: Logger;
}

/**
 * The CSRF middleware (handler stage, order 150, after authentication): requests authenticated by a session cookie
 * with an unsafe method pass only from the service's own origin or an allowed one (`origin` mode), or with a header
 * equal to the CSRF cookie (`token` mode).
 */
export function csrfMiddleware(options: CsrfOptions, context: CsrfContext): HandlerMiddleware {
  const ownOrigin = ownOriginReader(context.proxy);
  const configured = new OriginMatcher(options.origins);
  // `*` lets any page read CORS responses, never send a cookie-authenticated write.
  const cors = Array.isArray(context.corsOrigins) ? new OriginMatcher(context.corsOrigins.filter((origin) => origin !== "*")) : undefined;
  const corsFunction = typeof context.corsOrigins === "function" ? context.corsOrigins : undefined;
  const cookieAttributes = `Path=/; SameSite=Strict${context.production ? "; Secure" : ""}`;

  const allowedOrigin = async (req: ServiceRequest, origin: string) => {
    if (origin === ownOrigin(req) || configured.allows(origin) || cors?.allows(origin)) return true;
    if (!corsFunction) return false;
    const computed = (await resolveOption(corsFunction, { req })) ?? [];
    return new OriginMatcher(computed.filter((entry) => entry !== "*")).allows(origin);
  };

  const reject = (req: ServiceRequest, origin: string | undefined) => {
    safeLog(context.logger, "warn", { timestamp: new Date().toISOString(), message: "security.csrf.rejected", route: `${req.method} ${req.route}`, origin: origin ?? null });
    return csrfRejected();
  };

  return {
    stage: "handler",
    // After authentication (100), before tenancy (200) and the hooks.
    order: 150,
    async run(req, res, next) {
      if (req.auth?.method !== "cookie") return next();
      if (!context.appliesTo(req)) return next();
      const safe = SAFE_METHODS.has(req.method);
      if (options.mode === "token") {
        const cookie = cookieValue(req.headers.get("cookie") ?? "", options.cookie);
        if (safe) {
          if (cookie !== undefined || req.method !== "GET") return next();
          const value = randomBytes(32).toString("base64url");
          const result = await next();
          const setCookie = `${options.cookie}=${value}; ${cookieAttributes}`;
          if (result instanceof Response) {
            const copy = new Response(result.body, result);
            copy.headers.append("set-cookie", setCookie);
            return copy;
          }
          res.header("set-cookie", setCookie);
          return result;
        }
        const sent = req.headers.get(options.header);
        if (cookie === undefined || sent === null || !sameText(sent, cookie)) throw reject(req, req.headers.get("origin") ?? undefined);
        return next();
      }
      if (safe) return next();
      const fetchSite = req.headers.get("sec-fetch-site");
      if (fetchSite === "same-origin" || fetchSite === "none") return next();
      const header = req.headers.get("origin");
      const referer = header === null ? req.headers.get("referer") : null;
      const origin = header !== null ? normalizeOrigin(header) : referer !== null ? normalizeOrigin(referer) : undefined;
      if (origin === undefined || !(await allowedOrigin(req, origin))) throw reject(req, header ?? referer ?? undefined);
      return next();
    },
  };
}
