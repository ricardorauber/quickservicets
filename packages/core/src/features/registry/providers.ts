import { parseDuration, resolveRecords, safeLog, type JobClock, type Logger } from "../public.ts";
import type { RegistryProvider, ServiceInstance } from "./provider.ts";

/** One instance of a static service. */
export interface StaticInstanceOptions {
  url: string;
  version?: string;
  weight: number;
  zone?: string;
  metadata?: Record<string, string>;
}

/**
 * The built-in `static` provider: a service's instances are the `services` of the config, each passing with the id
 * `<name>-<index>`; registering, heartbeats and deregistering do nothing.
 */
export function staticProvider(services: Readonly<Record<string, { instances: readonly StaticInstanceOptions[] }>> = {}): RegistryProvider {
  return {
    register() {},
    heartbeat() {},
    deregister() {},
    resolve: (name) =>
      (services[name]?.instances ?? []).map((instance, index): ServiceInstance => ({
        id: `${name}-${index}`,
        name,
        ...(instance.version !== undefined ? { version: instance.version } : {}),
        address: instance.url.replace(/\/+$/, ""),
        status: "passing",
        ...(instance.zone !== undefined ? { zone: instance.zone } : {}),
        weight: instance.weight ?? 1,
        metadata: { ...(instance.metadata ?? {}) },
      })),
  };
}

/** The options of the `dns` provider. */
export interface DnsOptions {
  /** The host name to query, with `{name}` replaced by the service name. */
  template: string;
  records: "a" | "srv";
  port?: number;
  scheme: "http" | "https";
  refresh: string;
}

/** How often a failed refresh is logged per service at most. */
export const DNS_FAILURE_LOG_MS = 60_000;

/**
 * The built-in `dns` provider: a service's instances come from DNS, one per A and AAAA address (with `dns.port`) or
 * one per SRV target and port (with its weight), without versions; results are kept for the larger of the records' TTL
 * and `dns.refresh`, refreshed in the background before they expire, and a failed refresh keeps the instances it had.
 */
export function dnsProvider(options: DnsOptions, context: { logger: Logger; clock: () => JobClock }): RegistryProvider {
  const refreshMs = parseDuration(options.refresh) ?? 30_000;
  const cache = new Map<string, { instances: ServiceInstance[]; expires: number; timer?: unknown; loggedAt?: number }>();
  let closed = false;
  const hostOf = (name: string) => options.template.replaceAll("{name}", name);
  const lookup = async (name: string): Promise<{ instances: ServiceInstance[]; ttlMs: number }> => {
    const host = hostOf(name);
    if (options.records === "srv") {
      const query = host.startsWith("_") ? host : `_http._tcp.${host}`;
      const answer = await resolveRecords(query, "srv");
      const instances = (answer.srv ?? []).map((entry): ServiceInstance => ({ id: `${name}-${entry.name}-${entry.port}`, name, address: `${options.scheme}://${entry.name.replace(/\.$/, "")}:${entry.port}`, status: "passing", weight: Math.max(1, entry.weight), metadata: {} }));
      return { instances, ttlMs: (answer.ttl ?? 0) * 1000 };
    }
    const [hostname, explicitPort] = splitPort(host);
    const port = options.port ?? explicitPort;
    if (port === undefined) throw new Error(`registry.dns.port is required for a records unless the template carries a port`);
    const answer = await resolveRecords(hostname, "a");
    const instances = (answer.addresses ?? []).map((address): ServiceInstance => {
      const shown = address.includes(":") ? `[${address}]` : address;
      return { id: `${name}-${address}-${port}`, name, address: `${options.scheme}://${shown}:${port}`, status: "passing", weight: 1, metadata: {} };
    });
    return { instances, ttlMs: (answer.ttl ?? 0) * 1000 };
  };
  const refresh = async (name: string): Promise<ServiceInstance[]> => {
    const entry = cache.get(name);
    try {
      const { instances, ttlMs } = await lookup(name);
      const keep = Math.max(ttlMs, refreshMs);
      const next = { instances, expires: context.clock().now() + keep } as { instances: ServiceInstance[]; expires: number; timer?: unknown; loggedAt?: number };
      if (entry?.loggedAt !== undefined) next.loggedAt = entry.loggedAt;
      if (entry?.timer !== undefined) context.clock().clearTimeout(entry.timer);
      cache.set(name, next);
      // Refreshed in the background before the result expires.
      if (!closed) next.timer = context.clock().setTimeout(() => void refresh(name), Math.max(1, Math.floor(keep * 0.9)));
      return instances;
    } catch (error) {
      if (!entry) throw error;
      const now = context.clock().now();
      if (entry.loggedAt === undefined || now - entry.loggedAt >= DNS_FAILURE_LOG_MS) {
        entry.loggedAt = now;
        safeLog(context.logger, "warn", { timestamp: new Date(now).toISOString(), message: "registry.dns.failed", service: name, host: hostOf(name), reason: (error as Error)?.message ?? String(error) });
      }
      if (entry.timer !== undefined) context.clock().clearTimeout(entry.timer);
      entry.timer = closed ? undefined : context.clock().setTimeout(() => void refresh(name), refreshMs);
      return entry.instances;
    }
  };
  return {
    register() {},
    heartbeat() {},
    deregister() {},
    async resolve(name) {
      const entry = cache.get(name);
      if (entry && entry.expires > context.clock().now()) return entry.instances;
      return refresh(name);
    },
    close() {
      closed = true;
      for (const entry of cache.values()) if (entry.timer !== undefined) context.clock().clearTimeout(entry.timer);
      cache.clear();
    },
  };
}

/** A host and the port it carries after a colon, if any. */
function splitPort(host: string): [string, number | undefined] {
  const match = /^(.*):(\d+)$/.exec(host);
  return match && !match[1]!.includes(":") ? [match[1]!, Number(match[2])] : [host, undefined];
}
