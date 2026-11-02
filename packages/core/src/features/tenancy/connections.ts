import { hasTenantPlaceholder, http, isSecretReference, parseSecretReference, referenceForTenant, safeLog, secretsRuntime, secretValue, RESERVED_SECRET_SCHEMES, type Logger, type SecretReference } from "../public.ts";
import { directoryClock, type TenantInfo } from "./directory.ts";
import { MissingConnectionError, type ConnectionSource } from "./pools.ts";

/** The `connection` option: a template with `{tenant}`, a secret reference (with or without `{tenant}`), or a function of the tenant. */
export type ConnectionOption = string | SecretReference | ((context: { tenant: TenantInfo }) => unknown) | undefined;

/**
 * The secret reference a connection is, if any: a reference, or the text of a tenant entry that starts with a scheme a
 * secrets provider resolves (never a connection URL scheme).
 */
function referenceIn(value: unknown): SecretReference | undefined {
  if (isSecretReference(value)) return value;
  if (typeof value !== "string") return undefined;
  const scheme = /^([a-z][a-z0-9-]*):\/\//.exec(value)?.[1];
  if (scheme === undefined || RESERVED_SECRET_SCHEMES.includes(scheme) || !secretsRuntime()?.resolves(scheme)) return undefined;
  try {
    return parseSecretReference(value);
  } catch {
    return undefined;
  }
}

/**
 * The value of a connection that is a secret reference, for one tenant: `{tenant}` references through the per-tenant
 * cache of the `secrets` native (or read directly for `env://` and `file://` outside a service), others as resolved at
 * startup; any other value as it is.
 */
async function resolvedConnection(tenant: string, value: unknown): Promise<unknown> {
  const reference = referenceIn(value);
  if (!reference) return value;
  if (!hasTenantPlaceholder(reference)) return secretValue(reference);
  const runtime = secretsRuntime();
  return runtime ? runtime.forTenant(tenant, reference) : secretValue(referenceForTenant(reference, tenant));
}

export interface ConnectionResolverOptions {
  option: ConnectionOption;
  /** The `http.services` entry called as `GET /tenants/<id>/connection`. */
  service?: string;
  /** How long a resolved connection is kept without its own ttl, in milliseconds. */
  ttlMs: number;
  logger: Logger;
}

/** Fails like a connection that is not usable, naming the tenant and never the value. */
function checked(tenant: string, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if ((typeof value === "string" && value !== "") || (typeof value === "object" && !Array.isArray(value))) return value;
  throw new Error(`Invalid tenancy.connection for tenant ${tenant}: expected a connection text or object, got ${Array.isArray(value) ? "an array" : typeof value === "string" ? "an empty text" : `a ${typeof value}`}`);
}

/**
 * The connections of database-strategy tenants, in this order: the tenant's own `connection` in the directory, the
 * `connection` option (template or function), then `connectionService`. Each one is kept per worker for the service's
 * `ttl` or `ttlMs`, with one resolution in flight per tenant.
 */
export function connectionResolver(options: ConnectionResolverOptions): ConnectionSource {
  const cache = new Map<string, { value: unknown; until: number }>();
  const inFlight = new Map<string, Promise<unknown>>();
  const fromService = async (id: string): Promise<{ value: unknown; ttlMs?: number } | undefined> => {
    const response = await http.service(options.service as never).get(`/tenants/${encodeURIComponent(id)}/connection`).response();
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw new Error(`The connection service ${options.service} answered ${response.status}`);
    const body = await response.json<{ connection?: unknown; ttl?: unknown }>();
    return { value: body?.connection, ...(typeof body?.ttl === "number" && body.ttl > 0 ? { ttlMs: body.ttl * 1000 } : {}) };
  };
  const compute = async (tenant: TenantInfo): Promise<{ value: unknown; ttlMs: number }> => {
    const own = checked(tenant.id, await resolvedConnection(tenant.id, tenant.connection));
    if (own !== undefined) return { value: own, ttlMs: options.ttlMs };
    // Read at each resolution, so a value rotated in place is used.
    const option = options.option;
    const template = isSecretReference(option) ? await resolvedConnection(tenant.id, option) : option;
    const computed = typeof template === "function" ? await resolvedConnection(tenant.id, await template({ tenant })) : typeof template === "string" ? template.replaceAll("{tenant}", tenant.id) : undefined;
    const configured = checked(tenant.id, computed);
    if (configured !== undefined) return { value: configured, ttlMs: options.ttlMs };
    if (options.service) {
      const answered = await fromService(tenant.id);
      const value = checked(tenant.id, answered?.value);
      if (value !== undefined) return { value, ttlMs: answered!.ttlMs ?? options.ttlMs };
    }
    safeLog(options.logger, "warn", { timestamp: new Date(directoryClock.now()).toISOString(), message: "tenancy.connection.missing", tenant: tenant.id });
    throw new MissingConnectionError(tenant.id);
  };
  const run = (tenant: TenantInfo): Promise<unknown> => {
    const running = inFlight.get(tenant.id);
    if (running) return running;
    const work = (async () => {
      try {
        const { value, ttlMs } = await compute(tenant);
        cache.set(tenant.id, { value, until: directoryClock.now() + ttlMs });
        return value;
      } finally {
        inFlight.delete(tenant.id);
      }
    })();
    inFlight.set(tenant.id, work);
    return work;
  };
  return {
    cached(id) {
      const entry = cache.get(id);
      return entry ? { value: entry.value, fresh: directoryClock.now() < entry.until } : undefined;
    },
    async resolve(tenant) {
      const entry = cache.get(tenant.id);
      if (entry && directoryClock.now() < entry.until) return entry.value;
      return run(tenant);
    },
    refresh(tenant) {
      if (inFlight.has(tenant.id)) return;
      void run(tenant).catch(() => {});
    },
    drop: (id) => void cache.delete(id),
  };
}
