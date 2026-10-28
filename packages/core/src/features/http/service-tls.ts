import { readFileSync, realpathSync } from "node:fs";
import { ConfigError, loadCertificatePair, readCertificates, safeLog, type Logger } from "../public.ts";
import type { ServiceOptions } from "./options.ts";

/** The TLS material of a service, as `fetch` takes it. */
export interface ServiceTls {
  cert?: string;
  key?: string;
  ca?: string[];
  passphrase?: string;
  serverName?: string;
  rejectUnauthorized: boolean;
  /** The SHA-256 fingerprint of the client certificate, for logs. */
  fingerprint256?: string;
}

type TlsOptions = NonNullable<ServiceOptions["tls"]>;

const isPem = (value: string) => value.trimStart().startsWith("-----BEGIN");

/**
 * Reads and checks the TLS options of a service with the rules of `server.tls`: each value a file path or PEM text of
 * the right kind, and the key matching the certificate; fails with `Invalid http.services.<name>.tls.<key>: <reason>`.
 */
export function loadServiceTls(name: string, tls: TlsOptions): ServiceTls {
  const label = `http.services.${name}.tls`;
  if ((tls.cert === undefined) !== (tls.key === undefined)) throw new ConfigError(`Invalid ${label}: cert and key go together`);
  const base: ServiceTls = {
    ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}),
    ...(tls.serverName !== undefined ? { serverName: tls.serverName } : {}),
    rejectUnauthorized: tls.rejectUnauthorized !== false,
  };
  if (tls.cert !== undefined && tls.key !== undefined) {
    const pair = loadCertificatePair({ cert: tls.cert, key: tls.key, ...(tls.ca ? { ca: tls.ca } : {}), ...(tls.passphrase !== undefined ? { passphrase: tls.passphrase } : {}) }, label);
    return { ...base, cert: pair.cert, key: pair.key, ...(pair.ca ? { ca: pair.ca } : {}), fingerprint256: pair.info.fingerprint256 };
  }
  return { ...base, ...(tls.ca && tls.ca.length > 0 ? { ca: readCertificates(tls.ca, `${label}.ca`).pems } : {}) };
}

/** The files of a service's TLS options, which a change of is watched for. */
export function serviceTlsFiles(tls: TlsOptions): string[] {
  return [tls.cert, tls.key, ...(tls.ca ?? [])].filter((value): value is string => typeof value === "string" && !isPem(value));
}

const hashOf = (file: string) => {
  try {
    return new Bun.CryptoHasher("sha256").update(readFileSync(realpathSync(file))).digest("hex");
  } catch {
    return "missing";
  }
};

/** Watches the TLS files of services and swaps their material in place when a valid change is found. */
export class ServiceTlsWatcher {
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly failed = new Map<string, string>();

  constructor(
    private readonly entries: Map<string, { options: TlsOptions; material: ServiceTls }>,
    private readonly logger: Logger,
  ) {
    for (const [name, entry] of entries) this.hashes.set(name, new Map(serviceTlsFiles(entry.options).map((file) => [file, hashOf(file)])));
  }

  /** Whether any service has a file to watch. */
  get watching(): boolean {
    return [...this.hashes.values()].some((files) => files.size > 0);
  }

  /** Checks every service's files; a changed and valid set applies to the next calls. */
  check(): void {
    for (const [name, entry] of this.entries) {
      const previous = this.hashes.get(name)!;
      const current = new Map([...previous.keys()].map((file) => [file, hashOf(file)]));
      if (![...current].some(([file, hash]) => previous.get(file) !== hash)) continue;
      const key = [...current.values()].join(",");
      try {
        Object.assign(entry.material, loadServiceTls(name, entry.options));
      } catch (error) {
        if (this.failed.get(name) !== key) {
          this.failed.set(name, key);
          safeLog(this.logger, "error", { timestamp: new Date().toISOString(), message: "http.tls.reload.failed", service: name, reason: (error as Error)?.message ?? String(error) });
        }
        continue;
      }
      this.hashes.set(name, current);
      this.failed.delete(name);
      safeLog(this.logger, "info", { timestamp: new Date().toISOString(), message: "http.tls.reloaded", service: name, ...(entry.material.fingerprint256 ? { fingerprint256: entry.material.fingerprint256 } : {}) });
    }
  }
}
