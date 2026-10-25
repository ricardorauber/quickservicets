import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DatabaseAdapter, StoredRecord } from "../adapter.ts";
import { createApp } from "../app.ts";
import { resolveConfig } from "../config.ts";
import { builtInFileEntity } from "../files.ts";
import type { LogEntry } from "../logger.ts";
import type { EntityModel } from "../model.ts";
import { contractItem, contractOrganization, contractRecord } from "./adapter-contract.ts";

export interface AttackSuiteOptions {
  /** Names the adapter in every test, like `attack suite: sqlite`. */
  name: string;
  /** Returns a fresh, empty adapter whose `connect` creates the tables of the models it receives. */
  adapter: () => DatabaseAdapter | Promise<DatabaseAdapter>;
}

const fileEntity = builtInFileEntity("file");
const attackModels: EntityModel[] = [contractOrganization, contractItem, fileEntity];

interface Payload {
  label: string;
  value: string;
  /** Refused with 400 wherever it is sent, so it is never stored. */
  refused?: true;
}

/** SQL injection payloads, each sent as filter values, ids and body strings. */
export const SQL_PAYLOADS: Payload[] = [
  ...["' OR '1'='1", "1; DROP TABLE items; --", "\\' OR 1=1 --", '" OR ""="', "/* */", "%", "_", "\\"].map((value) => ({
    label: `'${value}'`,
    value,
  })),
  { label: "a NUL character", value: "a\u0000b", refused: true },
  { label: "a 10 KB string", value: "'; --".repeat(2048) },
];

interface Harness {
  adapter: DatabaseAdapter;
  fetch(method: string, path: string, body?: string): Promise<Response>;
  /** Every stored item and file, sorted by id, to compare before and after an attack. */
  snapshot(): Promise<StoredRecord[]>;
}

function setUp(options: AttackSuiteOptions): () => Harness {
  let harness: Harness | undefined;
  let adapter: DatabaseAdapter;
  beforeAll(async () => {
    adapter = await options.adapter();
    await adapter.connect(attackModels);
    const quiet = (_entry: LogEntry) => {};
    const config = resolveConfig({ database: adapter, logger: { info: quiet, warn: quiet, error: quiet } }, {});
    const app = createApp({ models: attackModels, crudRoutes: [], endpoints: [], hooks: new Map(), config });
    const all = async (model: EntityModel) =>
      (await adapter.findMany(model, { where: [], sort: [{ field: "id", direction: "asc" }], limit: 10_000, offset: 0 })).data;
    harness = {
      adapter,
      fetch: (method, path, body) =>
        app.server.fetch(
          new Request(`http://attack.test${path}`, {
            method,
            ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
          }),
        ),
      snapshot: async () => [...(await all(contractItem)), ...(await all(fileEntity))],
    };
  });
  afterAll(async () => {
    await adapter?.disconnect();
  });
  return () => harness!;
}

/** Creates items through the generated route, as a client would. */
async function seedItems(harness: Harness, titles: string[]): Promise<StoredRecord[]> {
  const stored: StoredRecord[] = [];
  for (const title of titles) {
    const response = await harness.fetch("POST", "/items", JSON.stringify({ title }));
    const record = (await expectNot500(response)) as StoredRecord;
    expect(response.status).toBe(201);
    expect(record.title).toBe(title);
    stored.push(record);
  }
  return stored;
}

const query = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;

async function expectNot500(response: Response): Promise<unknown> {
  const text = await response.text();
  expect(response.status, text).toBeLessThan(500);
  return text === "" ? undefined : JSON.parse(text);
}

async function expectValidationError(response: Response, message?: string): Promise<void> {
  const body = (await expectNot500(response)) as { error?: { code?: string; details?: { message: string }[] } };
  expect(response.status).toBe(400);
  expect(body.error?.code).toBe("VALIDATION_ERROR");
  if (message !== undefined) expect(body.error?.details?.map((detail) => detail.message)).toContain(message);
}

/** Runs a read attack and asserts that it neither failed with a 500 nor changed any stored record. */
async function readAttack(harness: Harness, path: string, method = "GET"): Promise<Response> {
  const before = await harness.snapshot();
  const response = await harness.fetch(method, path);
  const clone = response.clone() as Response;
  await expectNot500(response);
  expect(await harness.snapshot()).toEqual(before);
  return clone;
}

async function listedIds(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { id: string }[] };
  return body.data.map((record) => record.id).sort();
}

const idsOf = (records: StoredRecord[], keep: (title: string) => boolean) =>
  records.filter((record) => keep(record.title as string)).map((record) => record.id).sort();

/**
 * Registers `bun:test` tests that attack the generated routes of the contract entities over HTTP: SQL and MongoDB
 * injection payloads, malicious parameter names, prototype pollution and mass assignment. Each attack is its own test,
 * named after the payload, under `attack suite: <name>`.
 */
export function runAttackSuite(options: AttackSuiteOptions): void {
  describe(`attack suite: ${options.name}`, () => {
    describe("sql payloads", () => {
      const harness = setUp(options);
      let seeded: StoredRecord[] = [];
      beforeAll(async () => {
        const stored = SQL_PAYLOADS.filter((payload) => !payload.refused);
        const titles = ["Alpha", "Beta", ...stored.flatMap(({ value }) => [value, `x${value}y`])];
        seeded = await seedItems(harness(), titles);
      });
      const lower = (text: string) => text.toLowerCase();

      for (const { label, value, refused } of SQL_PAYLOADS) {
        const filters: [string, string, (title: string) => boolean][] = [
          ["eq", value, (title) => title === value],
          ["contains", value, (title) => lower(title).includes(lower(value))],
          ["startsWith", value, (title) => lower(title).startsWith(lower(value))],
          ["in", `${value},Alpha`, (title) => title === value || title === "Alpha"],
        ];
        for (const [op, raw, matches] of filters) {
          test(`sql: ${op} with ${label}`, async () => {
            const response = await readAttack(harness(), `/items${query({ [`where[title][${op}]`]: raw })}`);
            if (refused) await expectValidationError(response);
            else expect(await listedIds(response)).toEqual(idsOf(seeded, matches));
          });
        }

        test(`sql: id with ${label}`, async () => {
          const path = `/items/${encodeURIComponent(value)}`;
          for (const method of ["GET", "DELETE"]) {
            const response = await readAttack(harness(), path, method);
            expect([400, 404]).toContain(response.status);
          }
          const before = await harness().snapshot();
          const patched = await harness().fetch("PATCH", path, JSON.stringify({ title: "changed" }));
          await expectNot500(patched);
          expect([400, 404]).toContain(patched.status);
          expect(await harness().snapshot()).toEqual(before);
        });

        test(`sql: body with ${label}`, async () => {
          if (refused) {
            const before = await harness().snapshot();
            await expectValidationError(await harness().fetch("POST", "/items", JSON.stringify({ title: value })));
            await expectValidationError(await harness().fetch("PATCH", `/items/${seeded[0]!.id}`, JSON.stringify({ title: value })));
            expect(await harness().snapshot()).toEqual(before);
            return;
          }
          const created = await harness().fetch("POST", "/items", JSON.stringify({ title: value }));
          const record = (await expectNot500(created)) as { id: string; title: string };
          expect(created.status).toBe(201);
          expect(record.title).toBe(value);
          const read = await harness().fetch("GET", `/items/${record.id}`);
          expect(((await expectNot500(read)) as { title: string }).title).toBe(value);
          const stored = await harness().adapter.findById(contractItem, record.id);
          expect(stored!.title).toBe(value);
          const patched = await harness().fetch("PATCH", `/items/${seeded[0]!.id}`, JSON.stringify({ title: `${value}!` }));
          expect(((await expectNot500(patched)) as { title: string }).title).toBe(`${value}!`);
          await harness().fetch("PATCH", `/items/${seeded[0]!.id}`, JSON.stringify({ title: "Alpha" }));
          await harness().fetch("DELETE", `/items/${record.id}`);
        });
      }
    });

    describe("malicious names", () => {
      const harness = setUp(options);
      beforeAll(async () => {
        await seedItems(harness(), ["Alpha", "Beta"]);
      });
      const names: [string, Record<string, string>][] = [
        ["where[title;drop][eq]", { "where[title;drop][eq]": "x" }],
        ["where[title][eq;drop]", { "where[title][eq;drop]": "x" }],
        ["sort=title;drop", { sort: "title;drop" }],
        ["sort=title desc--", { sort: "title desc--" }],
        ["fields=title,(select 1)", { fields: "title,(select 1)" }],
        ["where[__proto__][eq]", { "where[__proto__][eq]": "x" }],
        ["sort=__proto__", { sort: "__proto__" }],
        ["fields=__proto__", { fields: "__proto__" }],
      ];
      for (const [label, params] of names) {
        test(`names: ${label}`, async () => {
          await expectValidationError(await readAttack(harness(), `/items${query(params)}`));
        });
      }
    });

    describe("nosql payloads", () => {
      const harness = setUp(options);
      let seeded: StoredRecord[] = [];
      const operatorText = '{"$gt": ""}';
      beforeAll(async () => {
        seeded = await seedItems(harness(), ["Alpha", "Beta", operatorText]);
      });

      for (const [label, body] of [
        ["body $ne", '{ "title": { "$ne": null } }'],
        ["body $where", '{ "title": { "$where": "1" } }'],
      ] as const) {
        test(`nosql: ${label}`, async () => {
          const before = await harness().snapshot();
          await expectValidationError(await harness().fetch("POST", "/items", body), "Must be a string");
          await expectValidationError(await harness().fetch("PATCH", `/items/${seeded[0]!.id}`, body), "Must be a string");
          expect(await harness().snapshot()).toEqual(before);
        });
      }

      test("nosql: where[title][$ne]", async () => {
        await expectValidationError(await readAttack(harness(), `/items${query({ "where[title][$ne]": "x" })}`));
      });

      test("nosql: where[$where][eq]", async () => {
        await expectValidationError(await readAttack(harness(), `/items${query({ "where[$where][eq]": "1" })}`));
      });

      test("nosql: operator text as a filter value", async () => {
        for (const op of ["eq", "contains", "startsWith", "in"]) {
          const response = await readAttack(harness(), `/items${query({ [`where[title][${op}]`]: operatorText })}`);
          expect(await listedIds(response)).toEqual(idsOf(seeded, (title) => title === operatorText));
        }
      });
    });

    describe("prototype pollution", () => {
      const harness = setUp(options);
      let target: StoredRecord;
      const prototypeKeys = Object.getOwnPropertyNames(Object.prototype).sort();
      beforeAll(async () => {
        target = (await seedItems(harness(), ["Alpha"]))[0]!;
      });
      afterAll(() => {
        expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(prototypeKeys);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      });

      const pollution = '{ "polluted": true }';
      for (const key of ["__proto__", "constructor", "prototype"]) {
        for (const [where, body] of [
          ["top level", `{ "title": "x", "${key}": ${pollution} }`],
          ["nested", `{ "title": "x", "meta": { "views": 1, "${key}": ${pollution} } }`],
          ["nested in an array", `{ "title": "x", "meta": { "views": 1, "lines": [{ "qty": 1, "${key}": ${pollution} }] } }`],
        ] as const) {
          test(`prototype: ${key} ${where}`, async () => {
            const before = await harness().snapshot();
            await expectValidationError(await harness().fetch("POST", "/items", body), "Unknown field");
            await expectValidationError(await harness().fetch("PATCH", `/items/${target.id}`, body), "Unknown field");
            expect(await harness().snapshot()).toEqual(before);
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
          });
        }
      }

      test("prototype: query parameters", async () => {
        await readAttack(harness(), `/items?__proto__[polluted]=true&constructor[prototype][polluted]=true`);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      });
    });

    describe("mass assignment", () => {
      const harness = setUp(options);
      let item: StoredRecord;
      let file: StoredRecord;
      beforeAll(async () => {
        item = (await seedItems(harness(), ["Alpha"]))[0]!;
        file = await harness().adapter.insert(
          fileEntity,
          contractRecord({ filename: "a.txt", mimeType: "text/plain", size: 1, storage: "default", storageKey: "files/a.txt" }),
        );
      });

      const refused = async (method: string, path: string, body: Record<string, unknown>, message: string) => {
        const before = await harness().snapshot();
        await expectValidationError(await harness().fetch(method, path, JSON.stringify(body)), message);
        expect(await harness().snapshot()).toEqual(before);
      };

      test("mass: unknown field", async () => {
        await refused("POST", "/items", { title: "x", extra: 1 }, "Unknown field");
        await refused("PATCH", `/items/${item.id}`, { extra: 1 }, "Unknown field");
      });

      for (const name of ["id", "createdAt", "updatedAt"]) {
        test(`mass: ${name}`, async () => {
          const value = name === "id" ? "chosen" : "2000-01-01T00:00:00.000Z";
          await refused("POST", "/items", { title: "x", [name]: value }, "Field is read-only");
          await refused("PATCH", `/items/${item.id}`, { [name]: value }, "Field is read-only");
          expect(await harness().adapter.findById(contractItem, "chosen")).toBeNull();
        });
      }

      for (const name of ["url", "mimeType", "size", "storage", "storageKey"]) {
        test(`mass: file ${name}`, async () => {
          const value = name === "size" ? 999 : "https://attacker.test/x";
          await refused("PATCH", `/files/${file.id}`, { [name]: value }, "Field is read-only");
          const stored = await harness().adapter.findById(fileEntity, file.id);
          expect(stored).toEqual(file);
        });
      }
    });
  });
}
