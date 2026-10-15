import { describe, expect, test } from "bun:test";
import { HttpError } from "../errors.ts";
import type { Repositories } from "../hooks.ts";
import { createServer, type Endpoint, type Route } from "./server.ts";

const route = (method: string, path: string, handler: Endpoint): Route => ({ method, path, handler });
const serve = (routes: Route[], production = true) =>
  createServer({ routes, repos: {} as Repositories, config: { production } });
const call = (server: ReturnType<typeof serve>, method: string, path: string, body?: string) =>
  server.fetch(new Request(`http://localhost${path}`, { method, body }));

describe("route matching", () => {
  const server = serve([
    route("GET", "/users/me", () => ({ route: "me" })),
    route("GET", "/users/[id]", (_, req) => ({ route: "byId", id: req.params.id })),
    route("GET", "/", () => ({ route: "root" })),
    route("GET", "/orgs/[orgId]/members/[memberId]", (_, req) => req.params),
  ]);

  test("static segments win over dynamic ones", async () => {
    expect(await (await call(server, "GET", "/users/me")).json()).toEqual({ route: "me" });
  });
  test("parameters are decoded", async () => {
    expect(await (await call(server, "GET", "/users/abc%20d")).json()).toEqual({ route: "byId", id: "abc d" });
  });
  test("root and nested params", async () => {
    expect(await (await call(server, "GET", "/")).json()).toEqual({ route: "root" });
    expect(await (await call(server, "GET", "/orgs/1/members/2")).json()).toEqual({ orgId: "1", memberId: "2" });
  });
  test("malformed encodings are rejected with 400", async () => {
    expect((await call(server, "GET", "/users/%E0%A4%A")).status).toBe(400);
  });
});

describe("request", () => {
  test("exposes method, path, params, query, headers, raw and a per-request context", async () => {
    const seen: unknown[] = [];
    const server = serve([
      route("POST", "/items/[id]", (_, req) => {
        seen.push(req.context.user);
        req.context.user = 1;
        return {
          method: req.method,
          path: req.path,
          params: req.params,
          q: req.query.get("q"),
          header: req.headers.get("x-test"),
          raw: req.raw instanceof Request,
          user: req.context.user,
        };
      }),
    ]);
    const request = () =>
      server.fetch(new Request("http://localhost/items/7?q=a", { method: "POST", headers: { "x-test": "yes" } }));
    expect(await (await request()).json()).toEqual({
      method: "POST",
      path: "/items/7",
      params: { id: "7" },
      q: "a",
      header: "yes",
      raw: true,
      user: 1,
    });
    await request();
    expect(seen).toEqual([undefined, undefined]);
  });

  test("json() is parsed once and cached", async () => {
    const server = serve([
      route("POST", "/", async (_, req) => {
        const first = await req.json();
        const second = await req.json();
        return { same: first === second, first };
      }),
    ]);
    expect(await (await call(server, "POST", "/", '{"a":1}')).json()).toEqual({ same: true, first: { a: 1 } });
  });

  test("invalid JSON bodies yield 400 Invalid JSON body", async () => {
    const server = serve([route("POST", "/", async (_, req) => req.json())]);
    const response = await call(server, "POST", "/", "{bad json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } });
  });
});

describe("return values", () => {
  test("objects become JSON with the status and headers set on res", async () => {
    const server = serve([
      route("POST", "/", (_, __, res) => {
        res.status(201).header("x-id", "x");
        return { id: "x", at: new Date("2026-01-02T03:04:05.000Z") };
      }),
    ]);
    const response = await call(server, "POST", "/");
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-id")).toBe("x");
    expect(await response.json()).toEqual({ id: "x", at: "2026-01-02T03:04:05.000Z" });
  });
  test("objects default to 200", async () => {
    expect((await call(serve([route("GET", "/", () => ({}))]), "GET", "/")).status).toBe(200);
  });
  test("undefined becomes an empty 204, or the status set on res", async () => {
    const empty = await call(serve([route("DELETE", "/", () => undefined)]), "DELETE", "/");
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    const accepted = await call(serve([route("POST", "/", (_, __, res) => void res.status(202))]), "POST", "/");
    expect(accepted.status).toBe(202);
  });
  test("native responses are sent unchanged", async () => {
    const response = await call(serve([route("GET", "/", () => new Response("ok", { status: 299 }))]), "GET", "/");
    expect(response.status).toBe(299);
    expect(await response.text()).toBe("ok");
  });
});

describe("404 and 405", () => {
  const server = serve([route("GET", "/users", () => [])]);
  test("unknown paths", async () => {
    const response = await call(server, "GET", "/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });
  test("known path with another method", async () => {
    const response = await call(server, "PATCH", "/users");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await response.json()).toEqual({ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } });
  });
});

describe("thrown errors", () => {
  test("HttpError keeps its status and code", async () => {
    const response = await call(serve([route("GET", "/", () => { throw new HttpError(403, "No"); })]), "GET", "/");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "FORBIDDEN", message: "No" } });
  });
  test("unexpected errors respect the production flag", async () => {
    const boom: Endpoint = () => {
      throw new Error("secret");
    };
    const production = await (await call(serve([route("GET", "/", boom)], true), "GET", "/")).text();
    expect(production).not.toContain("secret");
    const development = (await (await call(serve([route("GET", "/", boom)], false), "GET", "/")).json()) as {
      error: { details?: { stack?: string } };
    };
    expect(development.error.details?.stack).toContain("secret");
  });
});

test("Endpoint types the body and the result", () => {
  const typed: Endpoint<{ name: string }, { ok: boolean }> = async (_, req) => {
    const body = await req.json();
    const name: string = body.name;
    return { ok: name.length > 0 };
  };
  expect(typed).toBeDefined();
});
