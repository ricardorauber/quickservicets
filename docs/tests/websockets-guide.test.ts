import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/realtime");
const guide = readFileSync(join(content, "guides/websockets.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the WebSockets guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/rooms/[roomId]/announce/post.ts", "endpoints/rooms/[roomId]/ws.ts", "quickservicets.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## `ws.ts` and `defineSocket`",
      "## The upgrade and its hooks",
      "## Authentication from browsers",
      "Sec-WebSocket-Protocol",
      "access logs",
      "## Origin checks",
      "## Typed messages, routing by type and acknowledgments",
      "## Rooms and tenant namespaces",
      "## Publishing from endpoints and jobs",
      "## Limits and close codes",
      "## Workers and replicas",
      "at most once",
      "7900 bytes",
      "SocketTransport",
      "## Proxies and load balancers",
      "Sticky sessions are not required",
      "## WebSockets or Server-Sent Events",
      "## Customization",
      "Level 7",
      "## A browser client",
      "new WebSocket(",
    ]) {
      expect(guide.includes(topic) ? topic : `missing ${topic}`).toBe(topic);
    }
  });

  test("it is in the Guides sidebar, and the configuration guide, the Server-Sent Events guide and the guides index link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    for (const page of ["guides/configuration.md", "guides/server-sent-events.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/websockets/)");
  });
});
