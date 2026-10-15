import { describe, expect, test } from "bun:test";
import { BuildError } from "../errors.ts";
import { createProject } from "../testing/project.ts";
import { scanEndpoints } from "./scan-endpoints.ts";

const handler = "export default async () => ({});";
const scan = (paths: string[]) => scanEndpoints(createProject(Object.fromEntries(paths.map((path) => [path, handler]))));
const failure = (paths: string[]) => {
  try {
    scan(paths);
  } catch (error) {
    expect(error).toBeInstanceOf(BuildError);
    return (error as Error).message;
  }
  throw new Error("expected the scanner to fail");
};

test("static, dynamic and root routes", () => {
  expect(scan(["endpoints/get.ts", "endpoints/health/get.ts", "endpoints/organizations/[orgId]/get.ts"])).toEqual([
    { method: "GET", path: "/", pattern: "/", params: [], file: "endpoints/get.ts" },
    { method: "GET", path: "/health", pattern: "/health", params: [], file: "endpoints/health/get.ts" },
    {
      method: "GET",
      path: "/organizations/[orgId]",
      pattern: "/organizations/:",
      params: ["orgId"],
      file: "endpoints/organizations/[orgId]/get.ts",
    },
  ]);
});

test("every method and nested params in order", () => {
  const routes = scan(
    ["get", "post", "put", "patch", "delete"].map((method) => `endpoints/orgs/[orgId]/members/[memberId]/${method}.ts`),
  );
  expect(routes.map((route) => route.method).sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
  expect(routes[0]).toMatchObject({ pattern: "/orgs/:/members/:", params: ["orgId", "memberId"] });
});

test("other file names are rejected listing the allowed names", () => {
  const message = failure(["endpoints/users/fetch.ts"]);
  expect(message).toContain("endpoints/users/fetch.ts");
  expect(message).toContain("get, post, put, patch, delete");
});

test("non-TypeScript files are ignored", () => {
  expect(scanEndpoints(createProject({ "endpoints/README.md": "# docs", "endpoints/get.ts": handler }))).toHaveLength(1);
});

test("conflicting dynamic siblings are rejected naming both", () => {
  const message = failure(["endpoints/users/[id]/get.ts", "endpoints/users/[userId]/post.ts"]);
  expect(message).toContain("endpoints/users/[id]");
  expect(message).toContain("endpoints/users/[userId]");
});

describe("catch-all segments", () => {
  test.each(["[...path]", "[[...path]]"])("%s is rejected", (folder) => {
    expect(failure([`endpoints/files/${folder}/get.ts`])).toContain("not supported");
  });
});

describe("invalid segment names", () => {
  test.each(["Users", "user_list", "a b"])("static %s is rejected naming the folder", (folder) => {
    expect(failure([`endpoints/${folder}/get.ts`])).toContain(`endpoints/${folder}`);
  });
  test("invalid parameter names are rejected", () => {
    expect(failure(["endpoints/users/[1id]/get.ts"])).toContain("1id");
  });
});

test("a missing endpoints folder yields no routes", () => {
  expect(scanEndpoints(createProject({}))).toEqual([]);
});
