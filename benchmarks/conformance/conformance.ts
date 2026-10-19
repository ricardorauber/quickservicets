/**
 * Conformance test for benchmarks/CONTRACT.md. Runs against any base URL:
 *
 *   BASE_URL=http://localhost:8080 bun test ./benchmarks/conformance/conformance.ts
 *
 * The database must hold a fresh seed (benchmarks/seed) when the run starts: the first group compares responses
 * with golden values computed from the seed, and the last group deletes a seeded user.
 *
 * The file name has no ".test" suffix on purpose, so a plain `bun test` in the repository does not pick it up.
 */
import { describe, expect, test } from "bun:test";
import { generateDataset, type SeedOrganization, type SeedUser } from "../seed/data.ts";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const { users, organizations } = generateDataset();
const userById = new Map(users.map((u) => [u.id, u]));
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Allowed difference between the service clock and this machine's clock. */
const CLOCK_TOLERANCE_MS = 120_000;

type Res = { status: number; headers: Headers; body: any; text: string; bytes: Uint8Array };

async function call(method: string, path: string, init: { json?: unknown; raw?: string; form?: FormData; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...init.headers };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.raw !== undefined) {
    headers["content-type"] ??= "application/json";
    body = init.raw;
  } else if (init.form) {
    body = init.form;
  }
  const response = await fetch(BASE_URL + path, { method, headers, body });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let parsed: any = undefined;
  if ((response.headers.get("content-type") ?? "").startsWith("application/json") && text.length > 0) parsed = JSON.parse(text);
  return { status: response.status, headers: response.headers, body: parsed, text, bytes };
}

const get = (path: string) => call("GET", path);

type Detail = { field: string; message: string };
const sortDetails = (details: Detail[]) => [...details].sort((a, b) => `${a.field}\u0000${a.message}`.localeCompare(`${b.field}\u0000${b.message}`));

/** Checks an error response: status, JSON content type, code, message and (order-insensitive) details. */
function expectError(res: Res, status: number, code: string, message: string, details?: Detail[]) {
  expect({ status: res.status, contentType: (res.headers.get("content-type") ?? "").split(";")[0] }).toEqual({ status, contentType: "application/json" });
  expect(Object.keys(res.body ?? {})).toEqual(["error"]);
  const { details: actual, ...rest } = res.body.error;
  expect(rest).toEqual({ code, message });
  if (details === undefined) expect(actual).toBeUndefined();
  else expect(sortDetails(actual ?? [])).toEqual(sortDetails(details));
}

const invalidQuery = (res: Res, field: string, message: string) => expectError(res, 400, "VALIDATION_ERROR", "Invalid query", [{ field, message }]);
const invalidBody = (res: Res, details: Detail[]) => expectError(res, 400, "VALIDATION_ERROR", "Invalid body", details);

function expectJson(res: Res, status: number) {
  expect(res.status).toBe(status);
  expect((res.headers.get("content-type") ?? "").split(";")[0]).toBe("application/json");
}

/** A fresh record: UUID v7 id, ISO timestamps with milliseconds, close to now. */
function expectFreshSystemFields(record: any) {
  expect(record.id).toMatch(UUID_V7);
  expect(record.createdAt).toMatch(ISO_MS);
  expect(record.updatedAt).toMatch(ISO_MS);
  expect(Math.abs(Date.parse(record.createdAt) - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);
  expect(Date.parse(record.updatedAt)).toBeGreaterThanOrEqual(Date.parse(record.createdAt));
}

const pick = <T extends object>(record: T, fields: string[]) => Object.fromEntries(fields.map((f) => [f, (record as any)[f]]));
const page = (data: unknown[], total: number, limit = 20, offset = 0) => ({ data, total, limit, offset });

/** The default order of every list: createdAt descending, then id descending. */
const newestFirst = <T extends { createdAt: string; id: string }>(rows: T[]) =>
  [...rows].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));

const populated = (org: SeedOrganization) => ({ ...org, members: org.members.map((id) => userById.get(id)!) });

function statsOf(org: SeedOrganization) {
  const members = org.members.map((id) => userById.get(id)!);
  const ages = members.map((m) => m.age).filter((age): age is number => age !== null);
  return {
    members: members.length,
    admins: members.filter((m) => m.role === "admin").length,
    averageAge: ages.length === 0 ? null : ages.reduce((a, b) => a + b, 0) / ages.length,
  };
}

function expectStats(actual: any, expected: ReturnType<typeof statsOf>) {
  expect(Object.keys(actual).sort()).toEqual(["admins", "averageAge", "members"]);
  expect(actual.members).toBe(expected.members);
  expect(actual.admins).toBe(expected.admins);
  if (expected.averageAge === null) expect(actual.averageAge).toBeNull();
  else expect(actual.averageAge).toBeCloseTo(expected.averageAge, 9);
}

// Byte fixtures for uploads.
const PNG = new Uint8Array(await Bun.file(new URL("../load/fixtures/upload.png", import.meta.url)).arrayBuffer());
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
const TEXT = new TextEncoder().encode("hello, world\n");
const MAX_UPLOAD = 1024 * 1024;
/** PNG signature followed by filler, so the detected type is image/png. */
const pngOfSize = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set(PNG.subarray(0, 64));
  return bytes;
};
function upload(bytes: Uint8Array, filename: string, type: string | undefined, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], filename, type === undefined ? {} : { type }));
  for (const [name, value] of Object.entries(extra)) form.append(name, value);
  return call("POST", "/media", { form });
}

// ---------------------------------------------------------------------------------------------------------------

describe("health", () => {
  test("GET /health returns 200 { ok: true }", async () => {
    const res = await get("/health");
    expectJson(res, 200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("seeded data (golden answers from benchmarks/seed)", () => {
  const u0 = users[0]!;

  test("GET /users/{id} returns the seeded record", async () => {
    const res = await get(`/users/${u0.id}`);
    expectJson(res, 200);
    expect(res.body).toEqual(u0);
  });

  test("a user without age returns age: null", async () => {
    const noAge = users.find((u) => u.age === null)!;
    expect((await get(`/users/${noAge.id}`)).body).toEqual(noAge);
  });

  test("GET /users/{id}?fields=email,name returns only those fields", async () => {
    expect((await get(`/users/${u0.id}?fields=email,name`)).body).toEqual({ email: u0.email, name: u0.name });
  });

  test("GET /users defaults to limit 20, offset 0, newest first", async () => {
    const res = await get("/users");
    expectJson(res, 200);
    expect(res.body).toEqual(page(newestFirst(users).slice(0, 20), users.length));
  });

  test("GET /users?limit=20&offset=5000 pages through the default order", async () => {
    expect((await get("/users?limit=20&offset=5000")).body).toEqual(page(newestFirst(users).slice(5000, 5020), users.length, 20, 5000));
  });

  test("an offset past the end returns an empty page with the total", async () => {
    expect((await get("/users?limit=5&offset=10000")).body).toEqual(page([], users.length, 5, 10000));
  });

  test("the query scenario request: filters, multi-field sort, field selection", async () => {
    const matching = users.filter((u) => u.role === "admin" && u.age !== null && u.age >= 30);
    const expected = [...matching]
      .sort((a, b) => b.age! - a.age! || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0) || (a.id < b.id ? 1 : -1))
      .slice(0, 20)
      .map((u) => pick(u, ["email", "name"]));
    const res = await get("/users?where[role][eq]=admin&where[age][gte]=30&sort=-age,email&fields=email,name&limit=20");
    expectJson(res, 200);
    expect(res.body).toEqual(page(expected, matching.length));
  });

  test("ascending sort puts nulls last; id descending breaks ties", async () => {
    const sorted = [...users].sort((a, b) => {
      if (a.age !== b.age) return a.age === null ? 1 : b.age === null ? -1 : a.age - b.age;
      return a.id < b.id ? 1 : -1;
    });
    expect((await get("/users?sort=age&fields=id,age&limit=30")).body).toEqual(page(sorted.slice(0, 30).map((u) => pick(u, ["id", "age"])), users.length, 30));
    expect((await get(`/users?sort=age&fields=id,age&limit=30&offset=${users.length - 30}`)).body).toEqual(
      page(sorted.slice(-30).map((u) => pick(u, ["id", "age"])), users.length, 30, users.length - 30),
    );
  });

  test("descending sort puts nulls first; id descending breaks ties", async () => {
    const sorted = [...users].sort((a, b) => {
      if (a.age !== b.age) return a.age === null ? -1 : b.age === null ? 1 : b.age - a.age;
      return a.id < b.id ? 1 : -1;
    });
    expect((await get("/users?sort=-age&fields=id,age&limit=50")).body).toEqual(page(sorted.slice(0, 50).map((u) => pick(u, ["id", "age"])), users.length, 50));
  });

  test("sort by createdAt ascending (oldest first)", async () => {
    expect((await get("/users?sort=createdAt&limit=3&fields=id")).body).toEqual(page(users.slice(0, 3).map((u) => ({ id: u.id })), users.length, 3));
  });

  test("sort by role then name descending", async () => {
    const sorted = [...users].sort((a, b) => (a.role === b.role ? (a.name < b.name ? 1 : a.name > b.name ? -1 : 0) : a.role < b.role ? -1 : 1));
    expect((await get("/users?sort=role,-name&limit=10&fields=role,name")).body).toEqual(page(sorted.slice(0, 10).map((u) => pick(u, ["role", "name"])), users.length, 10));
  });

  test.each([
    ["eq", 30, (age: number) => age === 30],
    ["ne", 30, (age: number) => age !== 30],
    ["gt", 70, (age: number) => age > 70],
    ["gte", 70, (age: number) => age >= 70],
    ["lt", 20, (age: number) => age < 20],
    ["lte", 20, (age: number) => age <= 20],
  ] as const)("where[age][%s]=%d", async (op, value, predicate) => {
    // "ne" follows SQL: rows whose age is null do not match.
    const total = users.filter((u) => u.age !== null && predicate(u.age)).length;
    const res = await get(`/users?where[age][${op}]=${value}&limit=1&fields=id`);
    expectJson(res, 200);
    expect(res.body.total).toBe(total);
  });

  test("where[role][eq]=admin counts the admins", async () => {
    const admins = users.filter((u) => u.role === "admin");
    expect((await get("/users?where[role][eq]=admin&limit=3")).body).toEqual(page(newestFirst(admins).slice(0, 3), admins.length, 3));
  });

  test("where[role][ne]=admin and where[role][in]=member,admin", async () => {
    expect((await get("/users?where[role][ne]=admin&limit=1")).body.total).toBe(users.filter((u) => u.role !== "admin").length);
    expect((await get("/users?where[role][in]=member,admin&limit=1")).body.total).toBe(users.length);
  });

  test("where[email][eq] finds one user", async () => {
    const u = users[42]!;
    expect((await get(`/users?where[email][eq]=${encodeURIComponent(u.email)}`)).body).toEqual(page([u], 1));
  });

  test("GET /organizations?limit=10 returns member ids in position order", async () => {
    const res = await get("/organizations?limit=10");
    expectJson(res, 200);
    expect(res.body).toEqual(page(newestFirst(organizations).slice(0, 10), organizations.length, 10));
  });

  test("GET /organizations?populate=members&limit=10 (the query scenario request)", async () => {
    const res = await get("/organizations?populate=members&limit=10");
    expectJson(res, 200);
    expect(res.body).toEqual(page(newestFirst(organizations).slice(0, 10).map(populated), organizations.length, 10));
  });

  test("GET /organizations/{id} and ?populate=members", async () => {
    const org = organizations[123]!;
    expect((await get(`/organizations/${org.id}`)).body).toEqual(org);
    expect((await get(`/organizations/${org.id}?populate=members`)).body).toEqual(populated(org));
  });

  test("GET /organizations?where[slug][eq]=org-0005", async () => {
    expect((await get("/organizations?where[slug][eq]=org-0005")).body).toEqual(page([organizations[5]!], 1));
  });

  test("GET /organizations?fields=name,slug&limit=2", async () => {
    expect((await get("/organizations?fields=name,slug&limit=2")).body).toEqual(page(newestFirst(organizations).slice(0, 2).map((o) => pick(o, ["name", "slug"])), organizations.length, 2));
  });

  test("GET /organizations/{orgId}/stats matches the seed", async () => {
    for (const org of [organizations[0]!, organizations[1]!, organizations[500]!, organizations[999]!]) {
      const res = await get(`/organizations/${org.id}/stats`);
      expectJson(res, 200);
      expectStats(res.body, statsOf(org));
    }
  });

  test("GET /organizations/{orgId}/stats for an unknown id is 404", async () => {
    expectError(await get("/organizations/does-not-exist/stats"), 404, "NOT_FOUND", "Organization not found");
  });

  test("GET /organizations/{id} for an unknown id is 404", async () => {
    expectError(await get("/organizations/does-not-exist"), 404, "NOT_FOUND", "Organization not found");
  });
});

describe("query parameter errors", () => {
  test.each([
    ["/users?limit=0", "limit", "Must be an integer from 1 to 100"],
    ["/users?limit=101", "limit", "Must be an integer from 1 to 100"],
    ["/users?limit=abc", "limit", "Must be an integer from 1 to 100"],
    ["/users?limit=2.5", "limit", "Must be an integer from 1 to 100"],
    ["/users?offset=-1", "offset", "Must be an integer of at least 0"],
    ["/users?foo=1", "foo", "Unknown parameter"],
    ["/users?limit=1&limit=2", "limit", "Parameter is repeated"],
    ["/users?sort=bogus", "sort", 'Field "bogus" cannot be sorted'],
    ["/users?where[age][gte]=abc", "where[age][gte]", "Must be a number"],
    ["/users?where[role][eq]=owner", "where[role][eq]", "Must be one of: member, admin"],
    ["/users?where[role][gt]=admin", "where[role][gt]", 'Operator "gt" is not allowed for this field'],
    ["/users?where[nope][eq]=1", "where[nope][eq]", 'Field "nope" cannot be filtered'],
    ["/users?fields=nope", "fields", "Unknown field: nope"],
    ["/organizations?limit=0", "limit", "Must be an integer from 1 to 100"],
    ["/organizations?sort=members", "sort", 'Field "members" cannot be sorted'],
  ])("%s", async (path, field, message) => {
    invalidQuery(await get(path), field, message);
  });

  test("several problems are reported together", async () => {
    expectError(await get("/users?limit=0&offset=-1&foo=2"), 400, "VALIDATION_ERROR", "Invalid query", [
      { field: "foo", message: "Unknown parameter" },
      { field: "limit", message: "Must be an integer from 1 to 100" },
      { field: "offset", message: "Must be an integer of at least 0" },
    ]);
  });

  test("GET /users/{id}?fields=nope", async () => {
    invalidQuery(await get(`/users/${users[0]!.id}?fields=nope`), "fields", "Unknown field: nope");
  });

  test("populate of a path that is not a reference", async () => {
    for (const path of ["/users?populate=email", "/organizations?populate=bogus"]) {
      const name = path.split("=")[1];
      expectError(await get(path), 400, "VALIDATION_ERROR", `Cannot populate: ${name}`, [{ field: "populate", message: `Cannot populate: ${name}` }]);
    }
  });

  test("an unknown route is 404 Route not found", async () => {
    expectError(await get("/does-not-exist"), 404, "NOT_FOUND", "Route not found");
  });
});

describe("users: create, read, update, delete", () => {
  const email = (label: string) => `conf-${RUN}-${label}@example.com`;
  let created: SeedUser;

  test("POST /users creates a user with the default role and age null", async () => {
    const res = await call("POST", "/users", { json: { email: email("a"), name: "Conformance A" } });
    expectJson(res, 201);
    expectFreshSystemFields(res.body);
    expect(res.body.createdAt).toBe(res.body.updatedAt);
    const { id, createdAt, updatedAt, ...rest } = res.body;
    expect(rest).toEqual({ email: email("a"), name: "Conformance A", role: "member", age: null });
    created = res.body;
  });

  test("POST /users with every field", async () => {
    const res = await call("POST", "/users", { json: { email: email("b"), name: "Conformance B", role: "admin", age: 33 } });
    expectJson(res, 201);
    expectFreshSystemFields(res.body);
    expect(pick(res.body, ["email", "name", "role", "age"])).toEqual({ email: email("b"), name: "Conformance B", role: "admin", age: 33 });
    expect((await call("DELETE", `/users/${res.body.id}`)).status).toBe(204);
  });

  test("POST /users accepts age: null and a 100-character name", async () => {
    const res = await call("POST", "/users", { json: { email: email("c"), name: "x".repeat(100), age: null } });
    expectJson(res, 201);
    expect(res.body.age).toBeNull();
    expect((await call("DELETE", `/users/${res.body.id}`)).status).toBe(204);
  });

  test("the created user can be read back", async () => {
    const res = await get(`/users/${created.id}`);
    expectJson(res, 200);
    expect(res.body).toEqual(created);
  });

  test.each([
    ["missing required fields", {}, [{ field: "email", message: "Is required" }, { field: "name", message: "Is required" }]],
    ["wrong types", { email: 123, name: 5 }, [{ field: "email", message: "Must be a string" }, { field: "name", message: "Must be a string" }]],
    ["bad email", { email: "not-an-email", name: "x" }, [{ field: "email", message: "Must be a valid email" }]],
    ["email with a space", { email: "a b@example.com", name: "x" }, [{ field: "email", message: "Must be a valid email" }]],
    ["empty name", { email: "e1@example.com", name: "" }, [{ field: "name", message: "Must be at least 1 characters" }]],
    ["long name", { email: "e2@example.com", name: "x".repeat(101) }, [{ field: "name", message: "Must be at most 100 characters" }]],
    ["null name", { email: "e3@example.com", name: null }, [{ field: "name", message: "Cannot be null" }]],
    ["unknown role", { email: "e4@example.com", name: "x", role: "owner" }, [{ field: "role", message: "Must be one of: member, admin" }]],
    ["role is case-sensitive", { email: "e5@example.com", name: "x", role: "ADMIN" }, [{ field: "role", message: "Must be one of: member, admin" }]],
    ["null role", { email: "e6@example.com", name: "x", role: null }, [{ field: "role", message: "Cannot be null" }]],
    ["fractional age", { email: "e7@example.com", name: "x", age: 30.5 }, [{ field: "age", message: "Must be an integer" }]],
    ["string age", { email: "e8@example.com", name: "x", age: "30" }, [{ field: "age", message: "Must be a number" }]],
    ["negative age", { email: "e9@example.com", name: "x", age: -1 }, [{ field: "age", message: "Must be at least 0" }]],
    ["age over 150", { email: "e10@example.com", name: "x", age: 151 }, [{ field: "age", message: "Must be at most 150" }]],
    ["unknown field", { email: "e11@example.com", name: "x", extra: 1 }, [{ field: "extra", message: "Unknown field" }]],
    [
      "read-only system fields",
      { email: "e12@example.com", name: "x", id: "abc", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" },
      [
        { field: "id", message: "Field is read-only" },
        { field: "createdAt", message: "Field is read-only" },
        { field: "updatedAt", message: "Field is read-only" },
      ],
    ],
    [
      "every problem at once",
      { email: "not-an-email", role: "owner", age: 30.5, extra: 1 },
      [
        { field: "email", message: "Must be a valid email" },
        { field: "name", message: "Is required" },
        { field: "role", message: "Must be one of: member, admin" },
        { field: "age", message: "Must be an integer" },
        { field: "extra", message: "Unknown field" },
      ],
    ],
  ] as const)("POST /users rejects %s", async (_label, body, details) => {
    invalidBody(await call("POST", "/users", { json: body }), details as unknown as Detail[]);
  });

  test("POST /users rejects a body that is not an object", async () => {
    for (const raw of ["[]", "null", '"text"', "42"]) {
      invalidBody(await call("POST", "/users", { raw }), [{ field: "", message: "Body must be a JSON object" }]);
    }
  });

  test("POST /users rejects invalid JSON", async () => {
    expectError(await call("POST", "/users", { raw: "{bad" }), 400, "VALIDATION_ERROR", "Invalid JSON body");
    expectError(await call("POST", "/users", { raw: "" }), 400, "VALIDATION_ERROR", "Invalid JSON body");
  });

  test("POST /users with a taken email is 409", async () => {
    const res = await call("POST", "/users", { json: { email: users[0]!.email, name: "Dup" } });
    expectError(res, 409, "CONFLICT", "Value already exists", [{ field: "email", message: "Value already exists" }]);
  });

  test("emails are unique case-sensitively", async () => {
    const res = await call("POST", "/users", { json: { email: users[0]!.email.toUpperCase(), name: "Upper" } });
    expectJson(res, 201);
    expect((await call("DELETE", `/users/${res.body.id}`)).status).toBe(204);
  });

  test("PATCH /users/{id} changes only the given fields and moves updatedAt", async () => {
    await Bun.sleep(5);
    const res = await call("PATCH", `/users/${created.id}`, { json: { name: "Renamed", age: 41 } });
    expectJson(res, 200);
    expect(res.body).toEqual({ ...created, name: "Renamed", age: 41, updatedAt: res.body.updatedAt });
    expect(res.body.updatedAt).toMatch(ISO_MS);
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    expect((await get(`/users/${created.id}`)).body).toEqual(res.body);
    created = res.body;
  });

  test("PATCH /users/{id} with age: null clears it", async () => {
    const res = await call("PATCH", `/users/${created.id}`, { json: { age: null, role: "admin" } });
    expectJson(res, 200);
    expect(pick(res.body, ["age", "role"])).toEqual({ age: null, role: "admin" });
    created = res.body;
  });

  test("PATCH /users/{id} with {} still moves updatedAt", async () => {
    await Bun.sleep(5);
    const res = await call("PATCH", `/users/${created.id}`, { json: {} });
    expectJson(res, 200);
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    expect({ ...res.body, updatedAt: created.updatedAt }).toEqual(created);
    created = res.body;
  });

  test.each([
    ["empty name", { name: "" }, [{ field: "name", message: "Must be at least 1 characters" }]],
    ["null name", { name: null }, [{ field: "name", message: "Cannot be null" }]],
    ["null role", { role: null }, [{ field: "role", message: "Cannot be null" }]],
    ["null email", { email: null }, [{ field: "email", message: "Cannot be null" }]],
    ["bad email", { email: "nope" }, [{ field: "email", message: "Must be a valid email" }]],
    ["age over 150", { age: 200 }, [{ field: "age", message: "Must be at most 150" }]],
    ["unknown field", { nickname: "x" }, [{ field: "nickname", message: "Unknown field" }]],
    ["read-only id", { id: "x" }, [{ field: "id", message: "Field is read-only" }]],
  ] as const)("PATCH /users/{id} rejects %s", async (_label, body, details) => {
    invalidBody(await call("PATCH", `/users/${created.id}`, { json: body }), details as unknown as Detail[]);
  });

  test("PATCH /users/{id} rejects invalid JSON and non-objects", async () => {
    expectError(await call("PATCH", `/users/${created.id}`, { raw: "{bad" }), 400, "VALIDATION_ERROR", "Invalid JSON body");
    invalidBody(await call("PATCH", `/users/${created.id}`, { raw: "[]" }), [{ field: "", message: "Body must be a JSON object" }]);
  });

  test("PATCH /users/{id} to a taken email is 409", async () => {
    const res = await call("PATCH", `/users/${created.id}`, { json: { email: users[1]!.email } });
    expectError(res, 409, "CONFLICT", "Value already exists", [{ field: "email", message: "Value already exists" }]);
  });

  test("PATCH /users/{id} for an unknown id is 404", async () => {
    expectError(await call("PATCH", "/users/does-not-exist", { json: { name: "x" } }), 404, "NOT_FOUND", "User not found");
  });

  test("GET /users/{id} for an unknown id is 404", async () => {
    expectError(await get("/users/does-not-exist"), 404, "NOT_FOUND", "User not found");
    expectError(await get("/users/01a154e8-0000-7000-8000-000000000000"), 404, "NOT_FOUND", "User not found");
  });

  test("DELETE /users/{id} returns 204 with no body, then the user is gone", async () => {
    const res = await call("DELETE", `/users/${created.id}`);
    expect(res.status).toBe(204);
    expect(res.bytes.length).toBe(0);
    expectError(await get(`/users/${created.id}`), 404, "NOT_FOUND", "User not found");
    expectError(await call("DELETE", `/users/${created.id}`), 404, "NOT_FOUND", "User not found");
  });
});

describe("media uploads", () => {
  let uploaded: any;

  test("POST /media stores a PNG and returns the file record", async () => {
    const res = await upload(PNG, "upload.png", "image/png");
    expectJson(res, 201);
    expectFreshSystemFields(res.body);
    const { id, createdAt, updatedAt, ...rest } = res.body;
    expect(rest).toEqual({ filename: "upload.png", mimeType: "image/png", size: PNG.length, storage: "default", url: `/media/${id}/file` });
    uploaded = res.body;
  });

  test("GET /media/{id} returns the same record", async () => {
    const res = await get(`/media/${uploaded.id}`);
    expectJson(res, 200);
    expect(res.body).toEqual(uploaded);
  });

  test("GET /media/{id}/file returns the bytes", async () => {
    const res = await get(`/media/${uploaded.id}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    expect(res.headers.get("content-disposition")).toBe('inline; filename="upload.png"');
    expect(Buffer.from(res.bytes).equals(Buffer.from(PNG))).toBe(true);
  });

  test("unknown media ids are 404", async () => {
    expectError(await get("/media/does-not-exist"), 404, "NOT_FOUND", "Media not found");
    expectError(await get("/media/does-not-exist/file"), 404, "NOT_FOUND", "Media not found");
  });

  test("a generic or missing declared type takes the detected type", async () => {
    for (const type of ["application/octet-stream", undefined]) {
      const res = await upload(PNG, "noext", type);
      expectJson(res, 201);
      expect(res.body.mimeType).toBe("image/png");
    }
  });

  test("declared type parameters and case are ignored when they match", async () => {
    const res = await upload(PNG, "upload.png", "IMAGE/PNG; charset=binary");
    expectJson(res, 201);
    expect(res.body.mimeType).toBe("image/png");
  });

  test("the file name is reduced to its base name", async () => {
    const res = await upload(PNG, "../../etc/evil.png", "image/png");
    expectJson(res, 201);
    expect(res.body.filename).toBe("evil.png");
  });

  test("PNG bytes declared as another type are 415", async () => {
    for (const declared of ["image/jpeg", "image/gif"]) {
      const res = await upload(PNG, "upload.png", declared);
      expectError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "File content does not match its type", [
        { field: "file", message: `Detected image/png, declared ${declared}` },
      ]);
    }
  });

  test("a recognized format outside @accept is 400 File type not allowed", async () => {
    invalidBody(await upload(GIF, "anim.gif", "image/gif"), [{ field: "file", message: "File type not allowed" }]);
    invalidBody(await upload(GIF, "anim.gif", "application/octet-stream"), [{ field: "file", message: "File type not allowed" }]);
  });

  test("unrecognized content keeps its declared type", async () => {
    invalidBody(await upload(TEXT, "notes.txt", "text/plain"), [{ field: "file", message: "File type not allowed" }]);
    const res = await upload(TEXT, "notes.txt", "image/png");
    expectJson(res, 201);
    expect(pick(res.body, ["mimeType", "size", "filename"])).toEqual({ mimeType: "image/png", size: TEXT.length, filename: "notes.txt" });
  });

  test("the size limit is 1 MiB inclusive", async () => {
    const atLimit = await upload(pngOfSize(MAX_UPLOAD), "max.png", "image/png");
    expectJson(atLimit, 201);
    expect(atLimit.body.size).toBe(MAX_UPLOAD);
    expectError(await upload(pngOfSize(MAX_UPLOAD + 1), "big.png", "image/png"), 413, "PAYLOAD_TOO_LARGE", "File too large");
  });

  test("a multipart body without a file part is 400", async () => {
    const form = new FormData();
    form.append("note", "x");
    invalidBody(await call("POST", "/media", { form }), [{ field: "file", message: "Is required" }]);
  });

  test("extra form fields are rejected", async () => {
    invalidBody(await upload(PNG, "upload.png", "image/png", { foo: "1" }), [{ field: "foo", message: "Unknown field" }]);
    invalidBody(await upload(PNG, "upload.png", "image/png", { filename: "other.png" }), [{ field: "filename", message: "Field is read-only" }]);
  });

  test("a JSON body is 415 Must be multipart/form-data", async () => {
    expectError(await call("POST", "/media", { json: { filename: "a.png" } }), 415, "UNSUPPORTED_MEDIA_TYPE", "Must be multipart/form-data");
  });
});

describe("deleting a seeded member (mutates the seed; runs last)", () => {
  test("DELETE /users/{id} removes the user from its organization and moves the organization's updatedAt", async () => {
    const org = organizations[7]!;
    const victim = org.members[3]!;
    expect((await call("DELETE", `/users/${victim}`)).status).toBe(204);
    const res = await get(`/organizations/${org.id}`);
    expectJson(res, 200);
    expect(res.body.members).toEqual(org.members.filter((id) => id !== victim));
    expect(Date.parse(res.body.updatedAt)).toBeGreaterThan(Date.parse(org.updatedAt));
    expect(Math.abs(Date.parse(res.body.updatedAt) - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);
    expectStats((await get(`/organizations/${org.id}/stats`)).body, statsOf({ ...org, members: org.members.filter((id) => id !== victim) }));
    const populatedRes = await get(`/organizations/${org.id}?populate=members&fields=members`);
    expect(populatedRes.body).toEqual({ members: org.members.filter((id) => id !== victim).map((id) => userById.get(id)!) });
  });
});
