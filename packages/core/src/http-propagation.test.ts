import { afterAll, describe, expect, test } from "bun:test";
import { requestClientsCreated } from "./features/http/client.ts";
import { http, type HttpClientError } from "./index.ts";
import type { ServiceRequest } from "./hooks.ts";
import { useTestResolver } from "./testing/index.ts";
import { resetHttpConfig, startHttpApp, upstream } from "./http-test-support.ts";

declare module "./features/http/client.ts" {
  interface HttpServiceNames {
    billing: true;
  }
}

afterAll(() => resetHttpConfig());

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as HttpClientError;
  }
  throw new Error("expected the call to fail");
};

/** A server answering with the headers it received; `/unavailable` answers 503. */
const echo = () =>
  upstream((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/unavailable")) return Response.json({ down: true }, { status: 503 });
    const headers = request.headers;
    return Response.json({
      requestId: headers.get("x-request-id"),
      user: headers.get("x-user-id"),
      tenant: headers.get("x-tenant-id"),
      authorization: headers.get("authorization"),
    });
  });

const signIn = (req: ServiceRequest) => {
  req.user = { id: "u1" } as ServiceRequest["user"];
  req.tenant = { id: "t1" } as ServiceRequest["tenant"];
};

describe("the request-bound client", () => {
  test("req.http sends the request's id as x-request-id unless the call sets one", async () => {
    const server = echo();
    const app = await startHttpApp({}, {
      "GET /call": (req) => req.http.get(`${server.url}/x`).send(),
      "GET /mine": (req) => req.http.get(`${server.url}/x`).header("x-request-id", "mine").send(),
    });
    try {
      const response = await app.fetch("/call");
      expect(((await response.json()) as { requestId: string }).requestId).toBe(response.headers.get("x-request-id")!);
      expect(((await (await app.fetch("/mine")).json()) as { requestId: string }).requestId).toBe("mine");
      expect(await http.get(`${server.url}/x`).send()).toMatchObject({ requestId: null });
    } finally {
      await app.stop();
      server.stop();
    }
  });

  test("a request that does not read req.http never creates its client", async () => {
    const app = await startHttpApp({}, { "GET /quiet": () => ({ ok: true }), "GET /reads": (req) => ({ has: typeof req.http.get }) });
    try {
      const before = requestClientsCreated();
      await app.fetch("/quiet");
      expect(requestClientsCreated()).toBe(before);
      await app.fetch("/reads");
      expect(requestClientsCreated()).toBe(before + 1);
    } finally {
      await app.stop();
    }
  });
});

describe("propagation", () => {
  test("a service propagates what it asks for, only through req.http.service, never to ad-hoc URLs", async () => {
    const server = echo();
    const restore = useTestResolver({ "billing.internal": "127.0.0.1" });
    const app = await startHttpApp({ http: { allow: ["loopback"], services: { billing: { url: `http://billing.internal:${server.port}`, propagate: ["user", "authorization"] } } } }, {
      "GET /billing": (req) => (signIn(req), req.http.service("billing").get("/x").send()),
      "GET /adhoc": (req) => (signIn(req), req.http.get(`${server.url}/x`).send()),
      "GET /override": (req) => (signIn(req), req.http.service("billing").get("/x").header("x-user-id", "other").send()),
      "GET /global": (req) => (signIn(req), http.service("billing").get("/x").send()),
    });
    try {
      const headers = { authorization: "Bearer abc" };
      expect(await (await app.fetch("/billing", { headers })).json()).toMatchObject({ user: "u1", tenant: null, authorization: "Bearer abc" });
      expect(await (await app.fetch("/adhoc", { headers })).json()).toMatchObject({ user: null, tenant: null, authorization: null });
      expect(await (await app.fetch("/override", { headers })).json()).toMatchObject({ user: "other" });
      expect(await (await app.fetch("/global", { headers })).json()).toMatchObject({ requestId: null, user: null, authorization: null });
    } finally {
      await app.stop();
      restore();
      server.stop();
    }
  });
});

describe("call logging", () => {
  test("one http.call entry per call, info below 400 and warn otherwise, without header values", async () => {
    const server = echo();
    const restore = useTestResolver({ "billing.internal": "127.0.0.1" });
    const app = await startHttpApp({ http: { allow: ["loopback"], services: { billing: { url: `http://billing.internal:${server.port}`, auth: { bearer: "service-token-1" } } } } }, {
      "GET /ok": (req) => req.http.service("billing").get("/ok").send(),
      "GET /down": (req) => req.http.service("billing").get("/unavailable").send(),
    });
    try {
      const ok = await app.fetch("/ok", { headers: { authorization: "Bearer abc" } });
      await app.fetch("/down");
      const calls = app.entries.filter((entry) => entry.message === "http.call");
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ level: "info", method: "GET", url: `http://billing.internal:${server.port}/ok`, service: "billing", status: 200, attempt: 1, requestId: ok.headers.get("x-request-id")! });
      expect(calls[1]).toMatchObject({ level: "warn", status: 503, service: "billing", attempt: 1 });
      expect(typeof calls[1]!.requestId).toBe("string");
      expect(typeof calls[0]!.durationMs).toBe("number");
      expect(JSON.stringify(calls)).not.toContain("service-token-1");
      expect(JSON.stringify(calls)).not.toContain("Bearer");
      const failed = await failure(http.get("http://127.0.0.1:1/x").send());
      expect(failed.code).toBe("NETWORK");
      expect(app.entries.filter((entry) => entry.message === "http.call").at(-1)).toMatchObject({ level: "warn", status: 0, error: "NETWORK" });
    } finally {
      await app.stop();
      restore();
      server.stop();
    }
  });

  test("logged and reported URLs mask secret query values and user information", async () => {
    const server = upstream(() => new Response("no", { status: 404 }));
    const restore = useTestResolver({ "api.test": "127.0.0.1" });
    const app = await startHttpApp({ http: { allow: ["api.test"] } });
    try {
      const error = await failure(http.get(`http://api.test:${server.port}/x?token=abc&page=2`).send());
      expect(error.url).toBe(`http://api.test:${server.port}/x?token=[secret]&page=2`);
      await failure(http.get(`http://user:pw@api.test:${server.port}/`).send());
      const urls = app.entries.filter((entry) => entry.message === "http.call").map((entry) => entry.url);
      expect(urls).toEqual([`http://api.test:${server.port}/x?token=[secret]&page=2`, `http://[secret]@api.test:${server.port}/`]);
    } finally {
      await app.stop();
      restore();
      server.stop();
    }
  });

  test("log: errors keeps only failures, and a service's log: off silences it alone", async () => {
    const server = echo();
    const restore = useTestResolver({ "billing.internal": "127.0.0.1" });
    const errorsOnly = await startHttpApp({ http: { allow: ["loopback"], log: "errors" } });
    try {
      await http.get(`${server.url}/fine`).send();
      await failure(http.get(`${server.url}/unavailable`).send());
      expect(errorsOnly.entries.filter((entry) => entry.message === "http.call").map((entry) => entry.status)).toEqual([503]);
    } finally {
      await errorsOnly.stop();
    }
    const quiet = await startHttpApp({ http: { allow: ["loopback"], services: { billing: { url: `http://billing.internal:${server.port}`, log: "off" } } } });
    try {
      await http.service("billing").get("/fine").send();
      await http.get(`${server.url}/fine`).send();
      expect(quiet.entries.filter((entry) => entry.message === "http.call").map((entry) => entry.service ?? "ad-hoc")).toEqual(["ad-hoc"]);
    } finally {
      await quiet.stop();
      restore();
      server.stop();
    }
  });
});
