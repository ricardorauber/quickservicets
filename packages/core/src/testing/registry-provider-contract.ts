import { test } from "bun:test";
import type { RegistryProvider, ServiceInstance } from "../features/registry/provider.ts";
import { activeTimers } from "./secret-provider-contract.ts";

/** What a provider's tests give the contract. */
export interface RegistryProviderFixtures {
  /** The instance the contract registers, heartbeats and deregisters. */
  instance: ServiceInstance;
  /** A service the provider resolves to at least one instance. */
  service: string;
  /** The versions the resolved instances of `service` carry, in any order, when they have versions. */
  versions?: readonly string[];
  /** Whether the provider resolves an instance it registered (registry servers do; static and DNS providers do not). */
  resolvesRegistered?: boolean;
  /** Changes the instances of `service` behind the provider, so a watch must report them. */
  change?: () => void | Promise<void>;
  /** A provider whose backend fails, and the secret values its error messages must never hold. */
  failing?: { create: () => RegistryProvider | Promise<RegistryProvider>; secrets: readonly string[] };
}

/** What `runRegistryProviderContract` takes besides the factory. */
export interface RegistryProviderContractOptions {
  /** Shown in the test titles (default `registry provider`). */
  name?: string;
  fixtures: RegistryProviderFixtures | (() => RegistryProviderFixtures | Promise<RegistryProviderFixtures>);
}

type Create = () => RegistryProvider | Promise<RegistryProvider>;

/** One check of the contract. */
export interface RegistryProviderCheck {
  name: string;
  run(create: Create, fixtures: RegistryProviderFixtures): Promise<void>;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const STATUSES = new Set(["passing", "warning", "critical"]);

/** Every check the contract runs, in order. */
export const REGISTRY_PROVIDER_CHECKS: readonly RegistryProviderCheck[] = [
  {
    name: "registers, heartbeats with each status and deregisters",
    async run(create, fixtures) {
      const provider = await create();
      try {
        await provider.register(fixtures.instance);
        for (const status of ["passing", "warning", "critical"] as const) await provider.heartbeat({ ...fixtures.instance, status }, status);
        if (fixtures.resolvesRegistered) {
          const found = await provider.resolve(fixtures.instance.name);
          if (!found.some((instance) => instance.id === fixtures.instance.id)) fail(`the registered instance ${fixtures.instance.id} is not resolved`);
        }
        await provider.deregister(fixtures.instance);
        if (fixtures.resolvesRegistered) {
          const left = await provider.resolve(fixtures.instance.name);
          if (left.some((instance) => instance.id === fixtures.instance.id)) fail(`the deregistered instance ${fixtures.instance.id} is still resolved`);
        }
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "resolves instances with their versions and statuses",
    async run(create, fixtures) {
      const provider = await create();
      try {
        const instances = await provider.resolve(fixtures.service);
        if (!Array.isArray(instances) || instances.length === 0) fail(`resolve(${JSON.stringify(fixtures.service)}) found no instance`);
        for (const instance of instances) {
          if (typeof instance.id !== "string" || instance.id === "") fail("an instance has no id");
          if (instance.name !== fixtures.service) fail(`instance ${instance.id} is named ${JSON.stringify(instance.name)}`);
          try {
            new URL(instance.address);
          } catch {
            fail(`instance ${instance.id} has the address ${JSON.stringify(instance.address)}, which is not a URL`);
          }
          if (!STATUSES.has(instance.status)) fail(`instance ${instance.id} has the status ${JSON.stringify(instance.status)}`);
          if (typeof instance.metadata !== "object" || instance.metadata === null) fail(`instance ${instance.id} has no metadata object`);
        }
        if (fixtures.versions) {
          const found = instances.map((instance) => instance.version ?? "").sort();
          if (JSON.stringify(found) !== JSON.stringify([...fixtures.versions].sort())) fail(`the versions are ${found.join(", ")}; expected ${[...fixtures.versions].sort().join(", ")}`);
        }
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "reports changes through watch when it watches",
    async run(create, fixtures) {
      const provider = await create();
      try {
        if (!provider.watch || !fixtures.change) return;
        let seen = 0;
        const stop = await provider.watch(fixtures.service, () => void seen++);
        await fixtures.change();
        for (let waited = 0; seen === 0 && waited < 2000; waited += 20) await Bun.sleep(20);
        stop();
        if (seen === 0) fail("the watch reported no change within 2 seconds");
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "fails without secret values in its messages",
    async run(_create, fixtures) {
      if (!fixtures.failing) return;
      const provider = await fixtures.failing.create();
      try {
        let error: unknown;
        try {
          await provider.resolve(fixtures.service);
        } catch (caught) {
          error = caught;
        }
        if (error === undefined) fail("the failing provider resolved; expected a rejection");
        const text = `${(error as Error)?.message ?? String(error)} ${(error as Error)?.stack ?? ""}`;
        for (const secret of fixtures.failing.secrets) if (secret.length >= 4 && text.includes(secret)) fail("the error holds a secret value");
      } finally {
        await provider.close?.();
      }
    },
  },
  {
    name: "leaves no timers after close()",
    async run(create, fixtures) {
      const left = await activeTimers(async () => {
        const provider = await create();
        await provider.register(fixtures.instance);
        await provider.resolve(fixtures.service);
        await provider.deregister(fixtures.instance);
        await provider.close?.();
      });
      if (left > 0) fail(`${left} timer${left === 1 ? " is" : "s are"} still active after close()`);
    },
  },
];

const fixturesOf = async (options: RegistryProviderContractOptions) => (typeof options.fixtures === "function" ? await options.fixtures() : options.fixtures);

/** Runs every check and resolves the failures, one `{ check, message }` each; an empty list means the provider passes. */
export async function checkRegistryProvider(create: Create, options: RegistryProviderContractOptions): Promise<{ check: string; message: string }[]> {
  const failures: { check: string; message: string }[] = [];
  for (const check of REGISTRY_PROVIDER_CHECKS) {
    try {
      await check.run(create, await fixturesOf(options));
    } catch (error) {
      failures.push({ check: check.name, message: (error as Error)?.message ?? String(error) });
    }
  }
  return failures;
}

/**
 * Registers one `bun:test` test per check of the registry provider contract: registration, heartbeats with each status
 * and deregistration, resolution with versions and statuses, watches when offered, failures without secrets in their
 * messages, and no timers left after `close()`.
 */
export function runRegistryProviderContract(create: Create, options: RegistryProviderContractOptions): void {
  for (const check of REGISTRY_PROVIDER_CHECKS) {
    test(`${options.name ?? "registry provider"}: ${check.name}`, async () => {
      await check.run(create, await fixturesOf(options));
    });
  }
}
