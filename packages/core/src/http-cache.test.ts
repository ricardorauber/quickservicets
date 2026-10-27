import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { resetCaches } from "./features/http/cache.ts";
import { resilienceClock } from "./features/http/resilience.ts";
import { http, withCache } from "./index.ts";
import { useTestResolver } from "./testing/index.ts";
import { resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

declare module "./features/http/client.ts" {
  interface HttpServiceNames {
    catalog: true;
  }
}

const realClock = { ...resilienceClock };
afterEach(() => {
  Object.assign(resilienceClock, realClock);
  resetCaches();
});
afterAll(() => resetHttpConfig());

const fakeClock = () => {
  const clock = { now: 5_000_000, advance: (ms: number) => void (clock.now += ms) };
  resilienceClock.now = () => clock.now;
  return clock;
};

/** A server answering `/path` with a counter and the headers `respond` gives for it. */
function counting(respond: (request: Request) => { status?: number; headers?: Record<string, string> } = () => ({})) {
  let count = 0;
  const server = upstream((request) => {
    count++;
    const { status = 200, headers = {} } = respond(request);
    return status === 304 ? new Response(null, { status, headers }) : Response.json({ count, language: request.headers.get("accept-language"), auth: request.headers.get("authorization") }, { status, headers });
  });
  return { server, calls: () => count };
}

describe("a service with cache: true", () => {
  test("a second GET within the ttl is a hit logged with attempt 0; after 61s the server is called again", async () => {
    const clock = fakeClock();
    const { server, calls } = counting();
    const restore = useTestResolver({ "catalog.internal": "127.0.0.1" });
    const app = await startHttpApp({ http: { allow: ["loopback"], services: { catalog: { url: `http://catalog.internal:${server.port}`, cache: true } } } });
    try {
      expect(await http.service("catalog").get("/products").send()).toMatchObject({ count: 1 });
      clock.advance(30_000);
      expect(await http.service("catalog").get("/products").send()).toMatchObject({ count: 1 });
      expect(calls()).toBe(1);
      clock.advance(31_000);
      expect(await http.service("catalog").get("/products").send()).toMatchObject({ count: 2 });
      const entries = app.entries.filter((entry) => entry.message === "http.call");
      expect(entries.map((entry) => [entry.cache, entry.attempt, entry.status])).toEqual([
        ["miss", 1, 200],
        ["hit", 0, 200],
        ["miss", 1, 200],
      ]);
    } finally {
      await app.stop();
      restore();
      server.stop();
    }
  });
});

describe("what is stored and for how long", () => {
  test("max-age wins over the ttl; no-store is never stored; no-cache revalidates; a 500 is not stored", async () => {
    const clock = fakeClock();
    resetHttpConfig();
    const { server, calls } = counting((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/short") return { headers: { "cache-control": "max-age=5" } };
      if (path === "/never") return { headers: { "cache-control": "no-store" } };
      if (path === "/check") return { headers: { "cache-control": "no-cache" } };
      if (path === "/broken") return { status: 500 };
      return {};
    });
    const cache = withCache();
    const get = (path: string) => http.get(`${server.url}${path}`).use(cache).response();
    try {
      await get("/short");
      clock.advance(4000);
      await get("/short");
      expect(calls()).toBe(1);
      clock.advance(2000);
      await get("/short");
      expect(calls()).toBe(2);
      await get("/never");
      await get("/never");
      expect(calls()).toBe(4);
      await get("/check");
      await get("/check");
      expect(calls()).toBe(6);
      await get("/broken");
      await get("/broken");
      expect(calls()).toBe(8);
      const response = await get("/short");
      const again = await get("/short");
      expect(response).not.toBe(again);
      expect(await response.json()).toEqual(await again.json());
    } finally {
      server.stop();
    }
  });

  test("a body larger than maxEntrySize passes through without being stored", async () => {
    resetHttpConfig();
    const { server, calls } = counting();
    const cache = withCache({ maxEntrySize: 10 });
    try {
      await http.get(server.url).use(cache).send();
      await http.get(server.url).use(cache).send();
      expect(calls()).toBe(2);
    } finally {
      server.stop();
    }
  });
});

describe("keys", () => {
  test("Vary keeps an entry per header value, and Vary: * is not stored", async () => {
    resetHttpConfig();
    const { server, calls } = counting((request) => ({ headers: { vary: new URL(request.url).pathname === "/any" ? "*" : "accept-language" } }));
    const cache = withCache();
    const get = (path: string, language: string) => http.get(`${server.url}${path}`).header("accept-language", language).use(cache).send<{ count: number; language: string }>();
    try {
      expect(await get("/greeting", "en")).toMatchObject({ language: "en", count: 1 });
      expect(await get("/greeting", "pt")).toMatchObject({ language: "pt", count: 2 });
      expect(await get("/greeting", "en")).toMatchObject({ language: "en", count: 1 });
      expect(await get("/greeting", "pt")).toMatchObject({ language: "pt", count: 2 });
      await get("/any", "en");
      await get("/any", "en");
      expect(calls()).toBe(4);
    } finally {
      server.stop();
    }
  });

  test("a call with authorization bypasses the cache; with private: true each token gets its own entry", async () => {
    const { server, calls } = counting();
    const app = await startHttpApp({});
    try {
      const shared = withCache();
      await http.get(server.url).bearer("a").use(shared).send();
      await http.get(server.url).bearer("a").use(shared).send();
      expect(calls()).toBe(2);
      expect(app.entries.filter((entry) => entry.message === "http.call").map((entry) => entry.cache)).toEqual(["bypass", "bypass"]);
      const personal = withCache({ name: "personal", private: true });
      expect(await http.get(server.url).bearer("a").use(personal).send()).toMatchObject({ auth: "Bearer a", count: 3 });
      expect(await http.get(server.url).bearer("b").use(personal).send()).toMatchObject({ auth: "Bearer b", count: 4 });
      expect(await http.get(server.url).bearer("a").use(personal).send()).toMatchObject({ auth: "Bearer a", count: 3 });
      expect(calls()).toBe(4);
    } finally {
      await app.stop();
      server.stop();
    }
  });

  test("Cache-Control: private is stored only with private: true", async () => {
    resetHttpConfig();
    const { server, calls } = counting(() => ({ headers: { "cache-control": "private, max-age=60" } }));
    try {
      const shared = withCache();
      await http.get(server.url).use(shared).send();
      await http.get(server.url).use(shared).send();
      expect(calls()).toBe(2);
      const personal = withCache({ name: "mine", private: true });
      await http.get(server.url).use(personal).send();
      await http.get(server.url).use(personal).send();
      expect(calls()).toBe(3);
    } finally {
      server.stop();
    }
  });
});

describe("revalidation", () => {
  test("a stale entry with an ETag is revalidated, and a 304 resolves the stored body logged as revalidated", async () => {
    const clock = fakeClock();
    const conditions: (string | null)[] = [];
    const { server, calls } = counting((request): { status?: number; headers: Record<string, string> } => {
      conditions.push(request.headers.get("if-none-match"));
      return request.headers.get("if-none-match") === '"v1"' ? { status: 304, headers: { etag: '"v1"' } } : { headers: { etag: '"v1"', "cache-control": "max-age=10" } };
    });
    const app = await startHttpApp({});
    try {
      const cache = withCache();
      expect(await http.get(server.url).use(cache).send()).toMatchObject({ count: 1 });
      clock.advance(11_000);
      expect(await http.get(server.url).use(cache).send()).toMatchObject({ count: 1 });
      expect(calls()).toBe(2);
      expect(conditions).toEqual([null, '"v1"']);
      expect(app.entries.filter((entry) => entry.message === "http.call").map((entry) => [entry.cache, entry.status])).toEqual([
        ["miss", 200],
        ["revalidated", 304],
      ]);
      // The refreshed entry is fresh again.
      await http.get(server.url).use(cache).send();
      expect(calls()).toBe(2);
    } finally {
      await app.stop();
      server.stop();
    }
  });

  test("a stale entry answered with something else than 304 is replaced", async () => {
    const clock = fakeClock();
    resetHttpConfig();
    const { server } = counting(() => ({ headers: { "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT", "cache-control": "max-age=1" } }));
    try {
      const cache = withCache();
      await http.get(server.url).use(cache).send();
      clock.advance(2000);
      expect(await http.get(server.url).use(cache).send()).toMatchObject({ count: 2 });
      expect(server.seen[1]!.headers.get("if-modified-since")).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
      expect(await http.get(server.url).use(cache).send()).toMatchObject({ count: 2 });
    } finally {
      server.stop();
    }
  });
});

describe("invalidation and eviction", () => {
  test("a PUT to a URL removes its cached GET; maxEntries evicts the least recently used", async () => {
    resetHttpConfig();
    const { server, calls } = counting();
    try {
      const cache = withCache({ maxEntries: 2 });
      const get = (path: string) => http.get(`${server.url}${path}`).use(cache).send();
      await get("/products/1");
      await http.put(`${server.url}/products/1`).json({}).use(cache).send();
      await get("/products/1");
      expect(calls()).toBe(3);
      await get("/a");
      await get("/products/1");
      await get("/b");
      expect(calls()).toBe(5);
      await get("/products/1");
      expect(calls()).toBe(5);
      await get("/a");
      expect(calls()).toBe(6);
    } finally {
      server.stop();
    }
  });
});
