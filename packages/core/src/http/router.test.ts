import { describe, expect, test } from "bun:test";
import { Router, type RouteMatch } from "./router.ts";

const routes = [
  ["GET", "/"],
  ["GET", "/users"],
  ["POST", "/users"],
  ["GET", "/users/[id]"],
  ["GET", "/users/me"],
  ["DELETE", "/users/[id]"],
  ["GET", "/[tenant]/users"],
  ["POST", "/[tenant]/settings"],
  ["GET", "/a/[x]/c"],
  ["GET", "/a/b/[y]"],
  ["GET", "/files/[first]"],
  ["GET", "/files/[second]"],
  ["put", "/[any]/[thing]/[here]"],
] as const;

const router = new Router(routes.map(([method, path]) => ({ method, path, value: `${method.toUpperCase()} ${path}` })));

const found = (match: RouteMatch<string>) => (match.kind === "found" ? [match.route.value, match.params] : match);

describe("indexed matching", () => {
  test("keeps static-over-dynamic precedence, declaration order between equals, and 405 across route shapes", () => {
    expect(found(router.match("GET", "/"))).toEqual(["GET /", {}]);
    expect(found(router.match("get", "/users/"))).toEqual(["GET /users", {}]);
    expect(found(router.match("GET", "/users/me"))).toEqual(["GET /users/me", {}]);
    expect(found(router.match("GET", "/users/a%20b"))).toEqual(["GET /users/[id]", { id: "a b" }]);
    expect(found(router.match("DELETE", "/users/me"))).toEqual(["DELETE /users/[id]", { id: "me" }]);
    // A static first segment wins over a dynamic one, and the first differing segment decides deeper down.
    expect(found(router.match("GET", "/acme/users"))).toEqual(["GET /[tenant]/users", { tenant: "acme" }]);
    expect(found(router.match("GET", "/a/b/c"))).toEqual(["GET /a/b/[y]", { y: "c" }]);
    expect(found(router.match("GET", "/a/z/c"))).toEqual(["GET /a/[x]/c", { x: "z" }]);
    expect(found(router.match("GET", "/files/report"))).toEqual(["GET /files/[first]", { first: "report" }]);
    expect(found(router.match("PUT", "/users/me/x"))).toEqual(["PUT /[any]/[thing]/[here]", { any: "users", thing: "me", here: "x" }]);

    // 405 lists the methods of every route that matches the path, whatever its first segment.
    expect(router.match("PATCH", "/users/me")).toEqual({ kind: "methodNotAllowed", allow: ["DELETE", "GET"] });
    expect(router.match("DELETE", "/users")).toEqual({ kind: "methodNotAllowed", allow: ["GET", "POST"] });
    expect(found(router.match("GET", "/users/settings"))).toEqual(["GET /users/[id]", { id: "settings" }]);
    expect(found(router.match("POST", "/users/settings"))).toEqual(["POST /[tenant]/settings", { tenant: "users" }]);
    expect(router.match("POST", "/users/users")).toEqual({ kind: "methodNotAllowed", allow: ["DELETE", "GET"] });
    expect(router.match("GET", "/acme/settings")).toEqual({ kind: "methodNotAllowed", allow: ["POST"] });

    expect(router.match("GET", "/nothing/here/at/all")).toEqual({ kind: "notFound" });
    expect(router.match("GET", "/a/b/c/d")).toEqual({ kind: "notFound" });
    expect(router.match("GET", "/b/c/d")).toEqual({ kind: "methodNotAllowed", allow: ["PUT"] });
  });
});
