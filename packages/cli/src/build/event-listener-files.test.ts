import { describe, expect, test } from "bun:test";
import { events } from "@quickservice/core";
import { createLinkedProject } from "../testing/project.ts";
import { startTestService } from "../testing/service.ts";
import { build } from "./build.ts";

const CONFIG = (keys = "events: {}") => `import { defineConfig, memoryAdapter } from "@quickservice/core";
export default defineConfig({ database: memoryAdapter(), ${keys} });
`;
const ENTITIES = {
  "entities/User.ts": "export type User = { email: string };\n",
  "entities/Note.ts": "export type Note = { text: string };\n",
};
const WELCOME = `import { listen } from "@quickservice/core";
export default listen("user.created", async (event, { repos, log }) => {
  log.info({ message: "welcome" });
  await repos.notes.create({ text: event.after.email });
});
`;
const failure = async (work: () => Promise<unknown>): Promise<Error> => {
  try {
    await work();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a failure");
};
const notes = (repos: unknown) => (repos as { notes: { query(): { all(): Promise<{ text: string }[]> } } }).notes.query().all();

describe("listener files", () => {
  test("events/welcome.ts creates a note after POST /users, typed from its pattern", async () => {
    const service = await startTestService({ files: { "quickservice.config.ts": CONFIG(), ...ENTITIES, "events/welcome.ts": WELCOME } });
    try {
      await service.fetch("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
      await events.idle();
      expect((await notes(service.repos)).map((note) => note.text)).toEqual(["ada@example.com"]);
    } finally {
      await service.stop();
    }
  });

  test("a file that does not default-export listen(...) fails the build", async () => {
    const root = createLinkedProject({ "quickservice.config.ts": CONFIG(), ...ENTITIES, "events/bad.ts": "export default 42;\n" });
    expect((await failure(() => build(root))).message).toBe("events/bad.ts: must default-export listen(...)");
  });

  test("a project file replaces a project feature's listener file of the same name, with an override line", async () => {
    const feature = `import { defineFeature } from "@quickservice/core";\nexport default defineFeature({ key: "greeter", requires: ["events"] });\n`;
    const shipped = `import { listen } from "@quickservice/core";\nexport default listen("user.created", (event, { repos }) => repos.notes.create({ text: "from feature" }).then(() => undefined));\n`;
    const project = `import { listen } from "@quickservice/core";\nexport default listen("user.created", (event, { repos }) => repos.notes.create({ text: "from project" }).then(() => undefined));\n`;
    const files = { "quickservice.config.ts": CONFIG("events: {}, greeter: {}"), ...ENTITIES, "features/greeter/index.ts": feature, "features/greeter/events/welcome.ts": shipped };

    const alone = await startTestService({ files });
    try {
      await alone.fetch("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@x.co" }) });
      await events.idle();
      expect((await notes(alone.repos)).map((note) => note.text)).toEqual(["from feature"]);
    } finally {
      await alone.stop();
    }

    const root = createLinkedProject({ ...files, "events/welcome.ts": project });
    const summary = await build(root);
    expect(summary.overrides).toContainEqual("Override: events/welcome.ts replaces features/greeter/events/welcome.ts from greeter");
    const replaced = await startTestService({ files: { ...files, "events/welcome.ts": project } });
    try {
      await replaced.fetch("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@x.co" }) });
      await events.idle();
      expect((await notes(replaced.repos)).map((note) => note.text)).toEqual(["from project"]);
    } finally {
      await replaced.stop();
    }
  });
});
