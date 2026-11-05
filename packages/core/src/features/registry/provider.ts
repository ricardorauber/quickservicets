/** The health of an instance, as a registry knows it. */
export type InstanceStatus = "passing" | "warning" | "critical";

/** One instance of a service in a registry. */
export interface ServiceInstance {
  /** Unique per instance: `<name>-<hostname>-<pid>` for the instances of this service. */
  id: string;
  name: string;
  version?: string;
  /** The base URL calls go to, like `http://10.0.0.5:8080`. */
  address: string;
  status: InstanceStatus;
  zone?: string;
  /** The weight of random balancing (default 1). */
  weight?: number;
  metadata: Record<string, string>;
}

/**
 * Where instances register and are found: a registry server (Consul, etcd, Eureka, Cloud Map), DNS, or a static list.
 * Features set one with `ctx.feature("registry").setProvider(provider)`.
 */
export interface RegistryProvider {
  /** Adds the instance; called once it is ready to serve. */
  register(instance: ServiceInstance): Promise<void> | void;
  /** Keeps the instance's entry alive with its current status. */
  heartbeat(instance: ServiceInstance, status: InstanceStatus): Promise<void> | void;
  /** Removes the instance, before it stops serving. */
  deregister(instance: ServiceInstance): Promise<void> | void;
  /** The known instances of a service. */
  resolve(name: string): Promise<ServiceInstance[]> | ServiceInstance[];
  /** Calls `onChange` with the instances of a service each time they change; returns a function that stops watching. */
  watch?(name: string, onChange: (instances: ServiceInstance[]) => void): (() => void) | Promise<() => void>;
  /** The provider's own health, for the `registry` check: resolves when healthy, throws when not. */
  health?(): Promise<unknown> | unknown;
  /** Stops the provider's timers and connections. */
  close?(): Promise<void> | void;
}

const STORE = Symbol.for("quickservicets.registry.state");

/** Process-wide state of the `registry` feature, shared with a copy ejected into a project. */
export function sharedState<T>(name: string, init: () => T): T {
  const store = ((globalThis as unknown as Record<symbol, Record<string, unknown>>)[STORE] ??= {});
  return (store[name] ??= init()) as T;
}
