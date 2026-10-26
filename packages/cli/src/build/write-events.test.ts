import { describe, expect, test } from "bun:test";
import { events, type WriteEvent } from "@quickservicets/core";
import { startTestService } from "../testing/service.ts";

const config = (keys: string) => `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter(), ${keys} });
`;

/** A project feature that records every event and refuses users named "veto" inside the write. */
const RECORDER = `import { defineFeature, HttpError, type WriteEvent } from "@quickservicets/core";
export default defineFeature({
  key: "recorder",
  requires: ["events"],
  middleware: [{ stage: "handler", run: (req, _res, next) => { (req as { user?: unknown }).user = { id: "u1" }; return next(); } }],
  setup(ctx) {
    const seen = ((globalThis as { recorded?: WriteEvent[] }).recorded = []);
    ctx.events.on("*", (event) => void seen.push(event));
    ctx.events.on("user.created", (event) => {
      if ((event.after as { name?: string }).name === "veto") throw new HttpError(422, "Vetoed");
    }, { phase: "inTransaction" });
  },
});
`;

const files = (keys = "events: {}, recorder: {}") => ({
  "quickservicets.config.ts": config(keys),
  "entities/User.ts": "export type User = { name: string };\n",
  "features/recorder/index.ts": RECORDER,
});
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const recorded = () => (globalThis as { recorded?: WriteEvent[] }).recorded ?? [];

describe("write events over HTTP", () => {
  test("POST, PATCH and DELETE deliver created, updated and deleted events with the request and its user", async () => {
    const service = await startTestService({ files: files() });
    try {
      const created = await service.fetch("/users", json("POST", { name: "A" }));
      const requestId = created.headers.get("x-request-id");
      const { id } = (await created.json()) as { id: string };
      await service.fetch(`/users/${id}`, json("PATCH", { name: "B" }));
      await service.fetch(`/users/${id}`, { method: "DELETE" });
      await events.idle();
      const seen = recorded();
      expect(seen.map((event) => event.type)).toEqual(["user.created", "user.updated", "user.deleted"]);
      expect(seen[0]).toMatchObject({ before: null, cause: "write", actor: { user: "u1" }, recordId: id });
      if (requestId) expect(seen[0]!.requestId).toBe(requestId);
      expect(seen[0]!.requestId).toBeString();
      expect(seen[1]).toMatchObject({ before: { name: "A" }, after: { name: "B" }, changed: ["name"] });
      expect(seen[2]).toMatchObject({ before: { name: "B" }, after: null });
      expect(seen[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    } finally {
      await service.stop();
    }
  });

  test("an in-transaction listener that throws fails the request and stores nothing", async () => {
    const service = await startTestService({ files: files() });
    try {
      const refused = await service.fetch("/users", json("POST", { name: "veto" }));
      expect(refused.status).toBe(422);
      expect(await (service.repos as unknown as { users: { query(): { all(): Promise<unknown[]> } } }).users.query().all()).toEqual([]);
    } finally {
      await service.stop();
    }
  });

  test("a feature using ctx.events without the native fails its setup", async () => {
    const listener = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({ key: "listener", setup: (ctx) => void ctx.events.on("*", () => undefined) });
`;
    const failed = startTestService({ files: { ...files("listener: {}"), "features/listener/index.ts": listener } });
    await expect(failed).rejects.toThrow("events is not enabled; add events: {} to quickservicets.config.ts");
  });
});
