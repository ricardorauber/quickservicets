import { parseDuration, type Logger } from "../public.ts";
import type { ServiceSettings } from "./client.ts";
import { discoveredInstances, discoverSettings, METADATA_HOSTS } from "./discovery.ts";
import { OUTLIER_DEFAULTS, outlierClock, recordOutcome, type OutlierSettings } from "./outlier.ts";

/** A discovered service's `probe` option, resolved. */
export interface ProbeSettings {
  enabled: boolean;
  path: string;
  interval: string;
  timeout: string;
}

/** Requests one instance's probe path: a 2xx answer within the timeout passes, anything else fails. */
async function probeOnce(address: string, settings: ProbeSettings): Promise<boolean> {
  if (METADATA_HOSTS.includes(new URL(address).hostname.replace(/^\[|\]$/g, "").toLowerCase())) return false;
  try {
    const response = await fetch(`${address.replace(/\/+$/, "")}${settings.path}`, { signal: AbortSignal.timeout(parseDuration(settings.timeout) ?? 2000), redirect: "manual" });
    await response.arrayBuffer().catch(() => undefined);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

/**
 * Probes the instances of every discovered service with `probe` enabled, every `interval`: non-2xx answers and errors
 * count as failures toward ejection and successes as recovery, in the resolution every call of this worker reads.
 * Resolves a function that stops the probes and their timers.
 */
export function startProbes(services: Iterable<ServiceSettings>, logger: Logger): () => void {
  const timers = new Set<unknown>();
  let stopped = false;
  for (const service of services) {
    // A per-request discover function has no fixed instances to probe.
    const discover = typeof service.discover === "function" ? undefined : discoverSettings(service.discover);
    const probe = service.probe as ProbeSettings | undefined;
    if (!discover || !probe?.enabled) continue;
    const outlier = (service.outlier ?? OUTLIER_DEFAULTS) as OutlierSettings;
    const interval = parseDuration(probe.interval) ?? 10_000;
    const round = async () => {
      if (stopped) return;
      try {
        const instances = await discoveredInstances(discover.name, discover);
        await Promise.all(instances.map(async (instance) => recordOutcome(service.name, instance, !(await probeOnce(instance.address, probe)), instances, outlier, logger)));
      } catch {
        // A failed resolution is the calls' problem; the next round tries again.
      }
      schedule();
    };
    const schedule = () => {
      if (stopped) return;
      const timer = outlierClock().setTimeout(() => {
        timers.delete(timer);
        void round();
      }, interval);
      timers.add(timer);
    };
    schedule();
  }
  return () => {
    stopped = true;
    for (const timer of timers) outlierClock().clearTimeout(timer);
    timers.clear();
  };
}
