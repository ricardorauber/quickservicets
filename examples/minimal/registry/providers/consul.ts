import { http, type InstanceStatus, type RegistryProvider, type ServiceInstance } from "@quickservicets/core";

/** What `registryConsul()` takes: the Consul agent's address and an ACL token. */
export interface ConsulOptions {
  /** The Consul agent (default `CONSUL_URL`, then `http://localhost:8500`). */
  url?: string;
  /** An ACL token, sent as `X-Consul-Token`. */
  token?: string;
  /** How long Consul keeps a service without a heartbeat before its check turns critical (default `30s`). */
  ttl?: string;
}

const CHECK = { passing: "pass", warning: "warn", critical: "fail" } as const satisfies Record<InstanceStatus, string>;

/**
 * A small Consul provider over the agent's HTTP API, for this example: register, TTL check heartbeats, deregister and
 * health-filtered resolution. The official Consul plugin replaces it with watches, ACL handling and more.
 */
export function registryConsul(options: ConsulOptions = {}): RegistryProvider {
  const base = (options.url ?? process.env.CONSUL_URL ?? "http://localhost:8500").replace(/\/+$/, "");
  const headers: Record<string, string> = options.token ? { "x-consul-token": options.token } : {};
  const put = (path: string, body?: unknown) => http.put(`${base}${path}`).headers(headers).json(body ?? {}).send();
  return {
    async register(instance) {
      const address = new URL(instance.address);
      await put("/v1/agent/service/register", {
        ID: instance.id,
        Name: instance.name,
        Address: address.hostname,
        Port: Number(address.port || (address.protocol === "https:" ? 443 : 80)),
        Meta: { ...instance.metadata, ...(instance.version ? { version: instance.version } : {}), ...(instance.zone ? { zone: instance.zone } : {}), scheme: address.protocol.replace(":", "") },
        Check: { CheckID: `service:${instance.id}`, TTL: options.ttl ?? "30s", DeregisterCriticalServiceAfter: "5m" },
      });
    },
    async heartbeat(instance, status) {
      await put(`/v1/agent/check/${CHECK[status]}/service:${instance.id}`);
    },
    async deregister(instance) {
      await put(`/v1/agent/service/deregister/${encodeURIComponent(instance.id)}`);
    },
    async resolve(name) {
      const entries = (await http.get(`${base}/v1/health/service/${encodeURIComponent(name)}`).headers(headers).send()) as { Service: { ID: string; Service: string; Address: string; Port: number; Meta?: Record<string, string> }; Checks?: { Status: string }[] }[];
      return entries.map((entry): ServiceInstance => {
        const { version, zone, scheme, ...metadata } = entry.Service.Meta ?? {};
        const worst = (entry.Checks ?? []).map((check) => check.Status);
        const status: InstanceStatus = worst.includes("critical") ? "critical" : worst.includes("warning") ? "warning" : "passing";
        return { id: entry.Service.ID, name: entry.Service.Service, address: `${scheme ?? "http"}://${entry.Service.Address}:${entry.Service.Port}`, status, ...(version ? { version } : {}), ...(zone ? { zone } : {}), metadata };
      });
    },
  };
}
