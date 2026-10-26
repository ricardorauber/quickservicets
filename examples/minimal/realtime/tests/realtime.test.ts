import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startTestService, type TestService } from "@quickservicets/cli/testing";

const root = join(import.meta.dir, "..");

/** The example's own files, as `startTestService` takes them. */
function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = { "quickservicets.config.ts": readFileSync(join(root, "quickservicets.config.ts"), "utf8") };
  for (const folder of ["endpoints", "entities"]) {
    for (const entry of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files[relative(root, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), "utf8");
    }
  }
  return files;
}

/** Reads the messages of an open stream as they arrive. */
function follow(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: { event?: string; id?: string; data: { record?: { title: string }; reason?: string } }[] = [];
  let buffer = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buffer += decoder.decode(value);
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(":")) continue;
        const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        messages.push({ ...(field("event") ? { event: field("event") } : {}), ...(field("id") ? { id: field("id") } : {}), data: JSON.parse(field("data")!) });
      }
    }
  })();
  return {
    messages,
    async waitFor(count: number) {
      for (let tries = 0; tries < 400 && messages.length < count; tries++) await Bun.sleep(5);
      return messages;
    },
    async close() {
      await reader.cancel();
      await pump;
    },
  };
}

const create = (service: TestService, title: string, status: "open" | "done") =>
  service.fetch("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, status }) });

test("the clock stream sends the time as Server-Sent Events", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const response = await service.fetch("/clock");
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const clock = follow(response);
    const [tick] = await clock.waitFor(1);
    expect(JSON.stringify(tick!.data)).toMatch(/^\{"now":"\d{4}-\d\d-\d\dT[^"]+"\}$/);
    await clock.close();
  } finally {
    await service.stop();
  }
});

test("a filtered change stream gets the open tasks, and a reconnecting client resumes with Last-Event-ID", async () => {
  const service = await startTestService({ files: exampleFiles() });
  try {
    const first = follow(await service.fetch("/tasks/changes?where[status][eq]=open"));
    await create(service, "Write the guide", "open");
    await create(service, "Ship it", "done");
    await create(service, "Review", "open");
    const seen = await first.waitFor(2);
    expect(seen.map((message) => [message.event, message.data.record!.title])).toEqual([
      ["created", "Write the guide"],
      ["created", "Review"],
    ]);
    const lastSeen = seen[0]!.id!;
    await first.close();
    const again = follow(await service.fetch("/tasks/changes?where[status][eq]=open", { headers: { "last-event-id": lastSeen } }));
    await create(service, "Celebrate", "open");
    const resumed = await again.waitFor(2);
    expect(resumed.map((message) => message.data.record!.title)).toEqual(["Review", "Celebrate"]);
    await again.close();
  } finally {
    await service.stop();
  }
});
