import { afterAll, describe, expect, test } from "bun:test";
import { memoryAdapter } from "./adapters/memory.ts";
import { resolveConfig, type ServiceConfig } from "./config.ts";
import { allowList, allowProblems, blockedCategory, isReservedName } from "./features/http/ssrf.ts";
import { redirected } from "./features/http/transport.ts";
import { http, type HttpClientError } from "./index.ts";
import { useTestResolver } from "./testing/index.ts";
import { resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

afterAll(() => resetHttpConfig());

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as HttpClientError;
  }
  throw new Error("expected the call to fail");
};

describe("classification", () => {
  test("IPv4, IPv6 and embedded IPv4 forms are classified; public addresses pass", () => {
    expect(blockedCategory("0.1.2.3")).toBe("an unspecified address");
    expect(blockedCategory("127.0.0.1")).toBe("a loopback address");
    expect(blockedCategory("::1")).toBe("a loopback address");
    expect(blockedCategory("::")).toBe("an unspecified address");
    expect(blockedCategory("10.1.2.3")).toBe("a private address");
    expect(blockedCategory("172.20.0.1")).toBe("a private address");
    expect(blockedCategory("192.168.1.1")).toBe("a private address");
    expect(blockedCategory("100.64.0.1")).toBe("a shared address");
    expect(blockedCategory("169.254.169.254")).toBe("a link-local address");
    expect(blockedCategory("fe80::1")).toBe("a link-local address");
    expect(blockedCategory("fd00::1")).toBe("a unique local address");
    expect(blockedCategory("192.0.0.8")).toBe("a reserved address");
    expect(blockedCategory("198.18.0.1")).toBe("a reserved address");
    expect(blockedCategory("240.0.0.1")).toBe("a reserved address");
    expect(blockedCategory("224.0.0.1")).toBe("a multicast address");
    expect(blockedCategory("ff02::1")).toBe("a multicast address");
    expect(blockedCategory("255.255.255.255")).toBe("a broadcast address");
    expect(blockedCategory("::ffff:127.0.0.1")).toBe("a loopback address");
    expect(blockedCategory("::ffff:7f00:1")).toBe("a loopback address");
    expect(blockedCategory("64:ff9b::a00:1")).toBe("a private address");
    expect(blockedCategory("64:ff9b::5db8:d822")).toBeUndefined();
    expect(blockedCategory("::ffff:93.184.216.34")).toBeUndefined();
    expect(blockedCategory("93.184.216.34")).toBeUndefined();
    expect(blockedCategory("2606:4700::1111")).toBeUndefined();
  });
});

describe("reserved names and protocols", () => {
  test("localhost, *.localhost and metadata names are reserved; other protocols are refused", async () => {
    for (const name of ["localhost", "LOCALHOST", "api.localhost", "metadata", "metadata.google.internal", "instance-data"]) expect(isReservedName(name)).toBe(true);
    expect(isReservedName("example.com")).toBe(false);
    resetHttpConfig();
    expect((await failure(http.get("file:///etc/passwd").send())).message).toBe("Blocked request to file:///etc/passwd: protocol file is not allowed");
    const ftp = await failure(http.get("ftp://example.com/").send());
    expect([ftp.code, ftp.message, ftp.method]).toEqual(["SSRF_BLOCKED", "Blocked request to ftp://example.com/: protocol ftp is not allowed", "GET"]);
  });

  test("blocked calls name the category and log http.ssrf.blocked without the query string", async () => {
    const app = await startHttpApp({ http: {} }, {
      "GET /call": async (req) => {
        try {
          await http.get(req.query.get("url")!).send();
          return { ok: true };
        } catch (error) {
          return { code: (error as HttpClientError).code, message: (error as HttpClientError).message };
        }
      },
    });
    try {
      const cases = [
        ["http://127.0.0.1:8080/?token=abc", "Blocked request to 127.0.0.1: 127.0.0.1 is a loopback address"],
        ["http://[::1]/", "Blocked request to ::1: ::1 is a loopback address"],
        ["http://10.1.2.3", "Blocked request to 10.1.2.3: 10.1.2.3 is a private address"],
        ["http://169.254.169.254/latest/meta-data", "Blocked request to 169.254.169.254: 169.254.169.254 is a link-local address"],
        ["http://[::ffff:127.0.0.1]", "Blocked request to ::ffff:7f00:1: ::ffff:7f00:1 is a loopback address"],
        ["http://localhost", "Blocked request to localhost: localhost is a reserved name"],
      ] as const;
      for (const [url, message] of cases) {
        expect(await (await app.fetch(`/call?url=${encodeURIComponent(url)}`)).json()).toEqual({ code: "SSRF_BLOCKED", message });
      }
      const logged = app.entries.filter((entry) => entry.message === "http.ssrf.blocked");
      expect(logged).toHaveLength(6);
      expect(logged[0]).toMatchObject({ level: "warn", host: "127.0.0.1", address: "127.0.0.1", category: "a loopback address" });
      expect(JSON.stringify(logged)).not.toContain("token");
    } finally {
      await app.stop();
    }
  });
});

describe("allow", () => {
  test("items are addresses, blocks or host names; hosts match the URL and blocks the addresses", () => {
    expect(allowProblems(["127.0.0.1/32", "loopback", "billing.internal", "*.internal", "nope!"])).toEqual([
      'Invalid http.allow[4]: expected an address, a CIDR block or a host name, got "nope!"',
    ]);
    expect(() => resolveConfig({ database: memoryAdapter(), http: { allow: ["nope!"] } } as ServiceConfig, {})).toThrow(
      'Invalid http.allow[0]: expected an address, a CIDR block or a host name, got "nope!"',
    );
    const list = allowList(["*.internal", "api.example.com", "10.0.0.0/8"]);
    expect([list.host("billing.internal"), list.host("a.b.internal"), list.host("internal"), list.host("API.example.com"), list.host("example.com")]).toEqual([true, true, false, true, false]);
    expect([list.address("10.0.0.5"), list.address("11.0.0.5"), list.host("10.0.0.5")]).toEqual([true, false, false]);
  });

  test("an allowed block reaches a local server; an allowed host passes while its address alone does not", async () => {
    const server = upstream(() => Response.json({ ok: true }));
    const restore = useTestResolver({ "billing.internal": "127.0.0.1" });
    try {
      resetHttpConfig({ allow: ["127.0.0.1/32"] });
      expect(await http.get(server.url).send()).toEqual({ ok: true });
      resetHttpConfig({ allow: ["*.internal"] });
      expect(await http.get(`http://billing.internal:${server.port}/`).send()).toEqual({ ok: true });
      expect(server.seen.at(-1)!.headers.get("host")).toBe(`billing.internal:${server.port}`);
      expect((await failure(http.get(server.url).send())).code).toBe("SSRF_BLOCKED");
      expect((await failure(http.get("http://10.0.0.5/").send())).message).toBe("Blocked request to 10.0.0.5: 10.0.0.5 is a private address");
    } finally {
      restore();
      server.stop();
    }
  });
});

describe("resolution and pinning", () => {
  test("any blocked address of a name blocks it, and the connection goes to the address that was checked", async () => {
    const server = upstream(() => new Response("reached"));
    resetHttpConfig({});
    const restoreMixed = useTestResolver({ "mixed.test": ["93.184.216.34", "10.0.0.5"] });
    try {
      expect((await failure(http.get("http://mixed.test/").send())).message).toBe("Blocked request to mixed.test: 10.0.0.5 is a private address");
    } finally {
      restoreMixed();
    }
    // A name answering a public address on the check and a private one afterward: only one resolution happens, and the
    // connection goes to the public address it checked, never to the local server.
    let resolutions = 0;
    const restore = useTestResolver({ "rebind.test": () => (resolutions++ === 0 ? "198.51.100.7" : "127.0.0.1") });
    try {
      const error = await failure(http.get(`http://rebind.test:${server.port}/`).timeout(300).send());
      expect(["TIMEOUT", "NETWORK"]).toContain(error.code);
      expect(resolutions).toBe(1);
      expect(server.seen).toHaveLength(0);
    } finally {
      restore();
      server.stop();
    }
  });
});

describe("redirects", () => {
  test("each hop is checked, the limit holds, credentials stay on their origin, and 303 turns a POST into a GET", async () => {
    let hops = 0;
    const server = upstream(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/to-local") return Response.redirect("http://127.0.0.1/secret", 302);
      if (url.pathname === "/chain") return Response.redirect(`/chain?n=${++hops}`, 302);
      if (url.pathname === "/cross") return Response.redirect(`http://other.test:${url.port}/landing`, 307);
      if (url.pathname === "/see-other") return Response.redirect("/landing", 303);
      return Response.json({ method: request.method, authorization: request.headers.get("authorization"), body: await request.text() });
    });
    const restore = useTestResolver({ "upstream.test": "127.0.0.1", "other.test": "127.0.0.1" });
    try {
      resetHttpConfig({ allow: ["upstream.test", "other.test"] });
      const base = `http://upstream.test:${server.port}`;
      const blocked = await failure(http.get(`${base}/to-local`).send());
      expect([blocked.code, blocked.message]).toEqual(["SSRF_BLOCKED", "Blocked request to 127.0.0.1: 127.0.0.1 is a loopback address"]);
      const tooMany = await failure(http.get(`${base}/chain`).send());
      expect([tooMany.code, tooMany.message, hops]).toEqual(["TOO_MANY_REDIRECTS", `Too many redirects from ${base}/chain`, 6]);
      expect(await http.get(`${base}/cross`).bearer("secret").send()).toEqual({ method: "GET", authorization: null, body: "" });
      expect(await http.post(`${base}/see-other`).json({ a: 1 }).send()).toEqual({ method: "GET", authorization: null, body: "" });
      const response = await http.get(`${base}/see-other`).response();
      expect(response.url).toBe(`${base}/landing`);
    } finally {
      restore();
      server.stop();
    }
  });

  test("307 and 308 keep the method and body; the same origin keeps the credentials", () => {
    const hop = { url: new URL("http://a.test/x"), method: "POST", headers: new Headers({ authorization: "Bearer t", cookie: "c=1", "content-type": "text/plain" }), body: "data" };
    const kept = redirected(hop, 308, new URL("http://a.test/y"));
    expect([kept.method, kept.body, kept.headers.get("authorization"), kept.headers.get("cookie")]).toEqual(["POST", "data", "Bearer t", "c=1"]);
    const moved = redirected(hop, 301, new URL("http://b.test/y"));
    expect([moved.method, moved.body, moved.headers.get("authorization"), moved.headers.get("cookie"), moved.headers.get("content-type")]).toEqual(["GET", undefined, null, null, null]);
  });
});

describe("turning it off", () => {
  test("ssrf: false lets local calls through, still refuses other protocols, and warns once at a production startup", async () => {
    const server = upstream(() => new Response("local"));
    try {
      resetHttpConfig({ ssrf: false });
      expect(await http.get(server.url).text()).toBe("local");
      expect((await failure(http.get("file:///etc/passwd").send())).code).toBe("SSRF_BLOCKED");
      const production = await startHttpApp({ production: true, http: { ssrf: false } });
      await production.stop();
      expect(production.entries.filter((entry) => entry.message === "http.ssrf.disabled")).toMatchObject([{ level: "warn" }]);
      const development = await startHttpApp({ http: { ssrf: false } });
      await development.stop();
      expect(development.entries.filter((entry) => entry.message === "http.ssrf.disabled")).toEqual([]);
    } finally {
      server.stop();
    }
  });
});
