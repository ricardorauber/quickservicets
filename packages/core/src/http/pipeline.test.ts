import { describe, expect, test } from "bun:test";
import { HttpError } from "../errors.ts";
import { definePostHook, definePreHook, type HookCall, type HookDefinition, type Repositories } from "../hooks.ts";
import { CRUD_OPERATIONS, type EntityModel } from "../model.ts";
import { entity } from "../testing/entities.ts";
import { executedHooks, operationForRoute, resolveRouteHooks, withHooks } from "./pipeline.ts";
import { createServer, type Endpoint } from "./server.ts";

const all = [...CRUD_OPERATIONS];
const users = (overrides: Partial<EntityModel> = {}) => entity("User", [], overrides);
const names = (calls: HookCall[]) => calls.map((call) => (call.args.length ? `${call.name}(${call.args})` : call.name));

test.each([
  ["GET", "/users", "list"],
  ["GET", "/users/:", "read"],
  ["POST", "/users", "create"],
  ["PATCH", "/users/:", "update"],
  ["PUT", "/users/:", "replace"],
  ["DELETE", "/users/:", "delete"],
  ["POST", "/users/:", undefined],
  ["GET", "/users/:/stats", undefined],
])("%s %s maps to %s", (method, pattern, operation) => {
  expect(operationForRoute(users(), method, pattern)).toBe(operation as never);
});

test("generated routes keep only entity hooks scoped to the operation", () => {
  const entity = users({ hooks: [{ name: "authorized", operations: ["create", "delete"], args: [] }] });
  expect(names(resolveRouteHooks({ kind: "generated", entity, operation: "create" }))).toEqual(["authorized"]);
  expect(names(resolveRouteHooks({ kind: "generated", entity, operation: "list" }))).toEqual([]);
});

describe("overrides", () => {
  const entityHooks = [
    { name: "authorized", operations: all, args: [] },
    { name: "audit", operations: all, args: [] },
  ];
  const endpointHooks = [
    { name: "authorized", args: ["admin"] },
    { name: "sanitize", args: [] },
  ];
  test("inherit puts entity hooks first and runs duplicates once with endpoint args", () => {
    const entity = users({ hooks: entityHooks });
    expect(names(resolveRouteHooks({ kind: "override", entity, operation: "read", endpointHooks }))).toEqual([
      "audit",
      "authorized(admin)",
      "sanitize",
    ]);
  });
  test("inherit without duplicates", () => {
    const entity = users({ hooks: [{ name: "audit", operations: all, args: [] }] });
    expect(
      names(resolveRouteHooks({ kind: "override", entity, operation: "read", endpointHooks: [{ name: "x", args: [] }] })),
    ).toEqual(["audit", "x"]);
  });
  test("replace keeps only endpoint hooks", () => {
    const entity = users({ hooks: entityHooks, overrideHooks: "replace" });
    expect(names(resolveRouteHooks({ kind: "override", entity, operation: "read", endpointHooks }))).toEqual([
      "authorized(admin)",
      "sanitize",
    ]);
  });
  test("custom endpoints keep only endpoint hooks", () => {
    expect(names(resolveRouteHooks({ kind: "custom", endpointHooks }))).toEqual(["authorized(admin)", "sanitize"]);
  });
});

describe("execution", () => {
  const order: string[] = [];
  const registry = new Map<string, HookDefinition>([
    ["authorized", definePreHook((_, req, __, args) => {
      order.push(`authorized(${args})`);
      if (req.headers.get("authorization") !== "yes") throw new HttpError(401, "Authentication required");
    })],
    ["audit", definePreHook(() => void order.push("audit"))],
    ["sanitize", definePostHook((data) => {
      order.push("sanitize");
      const { secret: _secret, ...rest } = data as Record<string, unknown>;
      return rest;
    })],
    ["stamp", definePostHook((data) => {
      order.push("stamp");
      return { ...(data as object), stamped: true };
    })],
  ]);
  const run = async (handler: Endpoint, calls: HookCall[], headers: Record<string, string> = { authorization: "yes" }) => {
    order.length = 0;
    let executed: string[] = [];
    const wrapped = withHooks(handler, calls, registry);
    const server = createServer({
      repos: {} as Repositories,
      config: { production: true },
      routes: [{
        method: "GET",
        path: "/",
        handler: async (repos, req, res) => {
          try {
            return await wrapped(repos, req, res);
          } finally {
            executed = executedHooks(req);
          }
        },
      }],
    });
    const response = await server.fetch(new Request("http://localhost/", { headers }));
    return { response, executed };
  };
  const calls = (...list: string[]) => list.map((name) => ({ name, args: name === "authorized" ? ["admin"] : [] }));

  test("pre-hooks run in order before the handler", async () => {
    await run(() => {
      order.push("handler");
      return {};
    }, calls("audit", "authorized"));
    expect(order).toEqual(["audit", "authorized(admin)", "handler"]);
  });

  test("a throwing pre-hook stops everything after it", async () => {
    let called = false;
    const { response } = await run(() => {
      called = true;
      return {};
    }, calls("authorized", "audit", "sanitize"), {});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    expect(called).toBe(false);
    expect(order).toEqual(["authorized(admin)"]);
  });

  test("post-hooks chain in order over the handler output", async () => {
    const { response } = await run(() => ({ id: 1, secret: "x" }), calls("sanitize", "stamp"));
    expect(await response.json()).toEqual({ id: 1, stamped: true });
    expect(order).toEqual(["sanitize", "stamp"]);
  });

  test("post-hooks are skipped for Response and undefined results", async () => {
    const native = await run(() => new Response("x"), calls("sanitize"));
    expect(await native.response.text()).toBe("x");
    const empty = await run(() => undefined, calls("sanitize"));
    expect(empty.response.status).toBe(204);
    expect(order).toEqual([]);
  });

  test("executed hook names are recorded on the request", async () => {
    const { executed } = await run(() => ({}), calls("audit", "authorized", "sanitize"));
    expect(executed).toEqual(["audit", "authorized", "sanitize"]);
  });
});
