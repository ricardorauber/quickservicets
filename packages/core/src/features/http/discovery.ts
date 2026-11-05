import { currentInstance, currentRegistryProvider, type Logger, type ServiceInstance } from "../public.ts";
import { isEjected, logPanic } from "./outlier.ts";
import { HttpClientError } from "./errors.ts";
import { sharedState } from "./state.ts";

/** How a discovered service spreads its calls. */
export type BalanceStrategy = "round-robin" | "least-connections" | "random";

/** A service's `discover` option, normalized. */
export interface DiscoverSettings {
  /** The registry name of the service. */
  name: string;
  balance: BalanceStrategy;
  preferZone: boolean;
}

/** The host of the placeholder base URL of a discovered service, replaced by an instance's address on each attempt. */
export const DISCOVERED_HOST = (service: string) => `${service}.discovered.invalid`;

/** The `discover` option of a service as settings, or undefined without one. */
export function discoverSettings(discover: unknown): DiscoverSettings | undefined {
  if (discover === undefined || discover === null) return undefined;
  if (typeof discover === "string") return { name: discover, balance: "round-robin", preferZone: true };
  const value = discover as Partial<DiscoverSettings>;
  return { name: String(value.name), balance: value.balance ?? "round-robin", preferZone: value.preferZone ?? true };
}

/** How long resolved instances are reused by one worker. */
export const DISCOVERY_CACHE_MS = 5000;

/** The cloud metadata addresses, which SSRF protection blocks even for discovered instances. */
export const METADATA_HOSTS: readonly string[] = ["169.254.169.254", "fd00:ec2::254"];

/** The resolution of one discovered service in this worker: cached instances, calls in flight and the round-robin turn. */
interface Resolution {
  instances: ServiceInstance[];
  at: number;
  watching?: () => void;
  turn: number;
  inFlight: Map<string, number>;
}

const resolutions = sharedState("discovery", () => ({ byService: new Map<string, Resolution>(), random: Math.random as () => number, now: Date.now as () => number }));

/** Forgets every resolution and stops their watches; the http native calls it at stop. */
export function resetDiscovery(): void {
  for (const resolution of resolutions.byService.values()) resolution.watching?.();
  resolutions.byService.clear();
}

/** Sets the random numbers of `random` balancing and the clock of the cache, for tests. */
export function setDiscoveryRandom(random: () => number = Math.random, now: () => number = Date.now): void {
  resolutions.random = random;
  resolutions.now = now;
}

/** The `NO_INSTANCES` error of a call that has no instance to go to. */
export const noInstances = (name: string, service: string, method: string, url: string) => new HttpClientError({ code: "NO_INSTANCES", message: `No instances of ${name}`, method, url, service });

/** The instances of a service: cached for 5 seconds per worker, kept current by the provider's `watch` when it has one. */
export async function discoveredInstances(service: string, settings: DiscoverSettings): Promise<ServiceInstance[]> {
  const provider = currentRegistryProvider();
  if (!provider) throw new Error(`http.services.${service}.discover needs registry: {} in quickservicets.config.ts`);
  let resolution = resolutions.byService.get(service);
  const now = resolutions.now();
  if (resolution && (resolution.watching || now - resolution.at < DISCOVERY_CACHE_MS)) return resolution.instances;
  const instances = await provider.resolve(settings.name);
  if (!resolution) {
    resolution = { instances, at: now, turn: 0, inFlight: new Map() };
    resolutions.byService.set(service, resolution);
    if (provider.watch) {
      const current = resolution;
      const stop = await provider.watch(settings.name, (changed) => {
        current.instances = changed;
        current.at = resolutions.now();
      });
      current.watching = stop;
    }
  } else {
    resolution.instances = instances;
    resolution.at = now;
  }
  return resolution.instances;
}

/** What `candidates` reads to leave ejected instances out and to log a panic. */
export interface CandidateContext {
  service: string;
  logger: Logger;
}

/**
 * The instances an attempt may go to: neither critical nor ejected, of the own zone first when preferred and
 * available; when none is left, every known instance (the panic rule: possibly failing instances beat failing every
 * call), logged as `registry.panic`.
 */
export function candidates(instances: readonly ServiceInstance[], settings: DiscoverSettings, ownZone: string | undefined, context?: CandidateContext): ServiceInstance[] {
  const healthy = instances.filter((instance) => instance.status !== "critical" && !(context && isEjected(context.service, instance, context.logger)));
  if (healthy.length === 0 && instances.length > 0 && context) {
    logPanic(context.service, context.logger);
    return [...instances];
  }
  if (settings.preferZone && ownZone !== undefined) {
    const local = healthy.filter((instance) => instance.zone === ownZone);
    if (local.length > 0) return local;
  }
  return healthy;
}

/** The instances of a service this worker resolved last, without resolving again. */
export function knownInstances(service: string): ServiceInstance[] | undefined {
  return resolutions.byService.get(service)?.instances;
}

/** Picks one instance by the strategy, avoiding the instances already tried by the call when another one is left. */
export function pickInstance(service: string, settings: DiscoverSettings, available: readonly ServiceInstance[], tried: ReadonlySet<string>): ServiceInstance | undefined {
  if (available.length === 0) return undefined;
  const fresh = available.filter((instance) => !tried.has(instance.id));
  const pool = fresh.length > 0 ? fresh : available;
  const resolution = resolutions.byService.get(service);
  if (settings.balance === "least-connections") {
    const load = (instance: ServiceInstance) => resolution?.inFlight.get(instance.id) ?? 0;
    return pool.reduce((best, instance) => (load(instance) < load(best) ? instance : best));
  }
  if (settings.balance === "random") {
    const total = pool.reduce((sum, instance) => sum + (instance.weight ?? 1), 0);
    let point = resolutions.random() * total;
    for (const instance of pool) {
      point -= instance.weight ?? 1;
      if (point < 0) return instance;
    }
    return pool[pool.length - 1];
  }
  const turn = resolution ? resolution.turn++ : 0;
  return pool[turn % pool.length];
}

/** Counts a call in flight to an instance until the returned function runs. */
export function trackInFlight(service: string, instance: ServiceInstance): () => void {
  const resolution = resolutions.byService.get(service);
  if (!resolution) return () => {};
  resolution.inFlight.set(instance.id, (resolution.inFlight.get(instance.id) ?? 0) + 1);
  return () => resolution.inFlight.set(instance.id, Math.max(0, (resolution.inFlight.get(instance.id) ?? 1) - 1));
}

/** The calls in flight to an instance in this worker. */
export function inFlightOf(service: string, id: string): number {
  return resolutions.byService.get(service)?.inFlight.get(id) ?? 0;
}

/** A URL of the placeholder base rebased on an instance's address, keeping the call's path and query. */
export function rebased(url: string, address: string, service: string): string {
  const current = new URL(url);
  const base = new URL(address);
  if (current.host !== DISCOVERED_HOST(service)) return url;
  const path = `${base.pathname.replace(/\/+$/, "")}${current.pathname}`;
  return `${base.origin}${path}${current.search}`;
}

/** The own instance's zone, for `preferZone`. */
export const ownZone = (): string | undefined => currentInstance()?.zone;
