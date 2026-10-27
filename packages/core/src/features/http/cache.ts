import { parseDuration, parseSize } from "../public.ts";
import { currentSettings, type HttpModifier, type HttpRequest, type HttpResponse } from "./client.ts";
import { copyRequest, defineModifier } from "./modifiers.ts";
import { resilienceClock } from "./resilience.ts";
import { sharedState } from "./state.ts";
import { BufferedResponse, CACHE_LABEL, logCall, maskedUrl } from "./transport.ts";

/** What `withCache` takes; every option has a default. */
export interface CacheOptions {
  /** The store's name (default: the service's name, else `default`). */
  name?: string;
  /** How long a response without `max-age` stays fresh (default `60s`). */
  ttl?: string | number;
  /** The longest a response stays fresh, whatever its `max-age` (default `1h`). */
  maxTtl?: string | number;
  /** Responses kept per store; the least recently used is evicted (default 1000). */
  maxEntries?: number;
  /** The largest body stored; a larger one passes through (default `1MB`). */
  maxEntrySize?: string | number;
  /**
   * Caches calls that carry `authorization` or `cookie`, keyed by a hash of them, and responses marked
   * `Cache-Control: private` (default false: such calls bypass the cache).
   */
  private?: boolean;
}

interface Entry {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
  url: string;
  storedAt: number;
  freshMs: number;
  /** `no-cache`: stored, but revalidated on every use. */
  revalidate: boolean;
}

interface Store {
  /** The `Vary` header names of each method, URL and credentials. */
  vary: Map<string, string[]>;
  /** Entries by key, least recently used first. */
  entries: Map<string, Entry>;
}

const stores = sharedState("caches", () => new Map<string, Store>());

const ms = (value: string | number) => (typeof value === "number" ? value : (parseDuration(value) ?? 0));
const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The directives of a `Cache-Control` header, lowercase, with their values. */
function directives(header: string | null): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of (header ?? "").split(",")) {
    const [name, value = ""] = part.trim().split("=");
    if (name) found.set(name.toLowerCase(), value.replace(/^"|"$/g, ""));
  }
  return found;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Forgets every cached response; for tests. */
export function resetCaches(): void {
  stores.clear();
}

/**
 * A modifier that keeps upstream `GET` and `HEAD` responses in memory per worker, following `Cache-Control`, `Vary`,
 * `ETag` and `Last-Modified`, never sharing responses of calls with credentials unless `private` is set, and dropping a
 * URL's responses after a successful write to it.
 */
export function withCache(options: CacheOptions = {}): HttpModifier {
  const ttl = ms(options.ttl ?? "60s");
  const maxTtl = ms(options.maxTtl ?? "1h");
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1000));
  const maxEntrySize = parseSize(options.maxEntrySize ?? "1MB") ?? 1024 * 1024;
  const allowPrivate = options.private ?? false;
  return defineModifier(async function cache(request, next): Promise<HttpResponse> {
    const name = options.name ?? request.service ?? "default";
    let store = stores.get(name);
    if (!store) stores.set(name, (store = { vary: new Map(), entries: new Map() }));
    const url = new URL(request.url);
    url.hash = "";
    const target = url.href;
    if (request.method !== "GET" && request.method !== "HEAD") {
      const response = await next();
      if (WRITES.has(request.method) && response.ok) {
        for (const key of [...store.entries.keys()]) if (key.split("\n")[1] === target) store.entries.delete(key);
      }
      return response;
    }
    const credentials = request.headers.has("authorization") || request.headers.has("cookie");
    if (credentials && !allowPrivate) return next(copyRequest(request, { [CACHE_LABEL]: "bypass" } as Partial<HttpRequest>));
    const base = [request.method, target, credentials ? sha256(`${request.headers.get("authorization") ?? ""}\n${request.headers.get("cookie") ?? ""}`) : ""].join("\n");
    const keyOf = (names: readonly string[]) => [base, ...names.map((header) => `${header}=${request.headers.get(header) ?? ""}`)].join("\n");
    const key = keyOf(store.vary.get(base) ?? []);
    const entry = store.entries.get(key);
    const now = resilienceClock.now();
    const cached = (from: Entry) => new BufferedResponse(from.status, new Headers(from.headers), from.url, from.body.slice(), (cause) => cause as Error);
    if (entry && !entry.revalidate && now - entry.storedAt < entry.freshMs) {
      // A hit: the most recently used entry, answered without a call.
      store.entries.delete(key);
      store.entries.set(key, entry);
      const settings = currentSettings();
      logCall(settings, request, { url: maskedUrl(request.url, settings), status: entry.status, durationMs: 0, attempt: 0, cache: "hit" });
      return cached(entry);
    }
    const etag = entry?.headers.find(([header]) => header === "etag")?.[1];
    const modified = entry?.headers.find(([header]) => header === "last-modified")?.[1];
    const revalidating = entry !== undefined && (etag !== undefined || modified !== undefined);
    const attempt = copyRequest(request, { [CACHE_LABEL]: revalidating ? "revalidate" : "miss" } as Partial<HttpRequest>);
    if (revalidating && etag !== undefined) attempt.headers.set("if-none-match", etag);
    if (revalidating && modified !== undefined) attempt.headers.set("if-modified-since", modified);
    const response = await next(attempt);
    if (revalidating && response.status === 304) {
      const refreshed = { ...entry!, storedAt: resilienceClock.now(), freshMs: freshness(response.headers, entry!) };
      store.entries.delete(key);
      store.entries.set(key, refreshed);
      return cached(refreshed);
    }
    store.entries.delete(key);
    const control = directives(response.headers.get("cache-control"));
    const vary = (response.headers.get("vary") ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter((header) => header !== "");
    const storable =
      (response.status === 200 || response.status === 203) && !control.has("no-store") && !vary.includes("*") && (!control.has("private") || allowPrivate);
    if (!storable) return response;
    const body = await response.bytes();
    if (body.byteLength > maxEntrySize) return response;
    const maxAge = Number(control.get("max-age"));
    const stored: Entry = {
      status: response.status,
      headers: [...response.headers.entries()],
      body,
      url: response.url,
      storedAt: resilienceClock.now(),
      freshMs: Number.isFinite(maxAge) && control.has("max-age") ? Math.min(maxAge * 1000, maxTtl) : Math.min(ttl, maxTtl),
      revalidate: control.has("no-cache"),
    };
    store.vary.set(base, vary);
    store.entries.set(keyOf(vary), stored);
    while (store.entries.size > maxEntries) store.entries.delete(store.entries.keys().next().value!);
    return response;

    function freshness(headers: Headers, previous: Entry): number {
      const refreshed = directives(headers.get("cache-control"));
      const age = Number(refreshed.get("max-age"));
      return refreshed.has("max-age") && Number.isFinite(age) ? Math.min(age * 1000, maxTtl) : previous.freshMs;
    }
  }, "cache");
}
