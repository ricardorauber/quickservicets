import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineFeature, registeredNatives, registerNative } from "../../packages/core/src/index.ts";
import { unregisterNative } from "../../packages/core/src/features.ts";

const root = join(import.meta.dir, "../..");
const content = join(import.meta.dir, "../src/content/docs");
const guide = readFileSync(join(content, "guides/features.md"), "utf8");

/** The rows of the guide's table of natives, by key. */
function tableRows(markdown: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  const section = markdown.split("## Every native")[1]?.split("\n## ")[0] ?? "";
  for (const line of section.split("\n")) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const key = /^`([a-z][a-z0-9-]*)`$/.exec(cells[0] ?? "")?.[1];
    if (key) rows.set(key, cells);
  }
  return rows;
}

/** The problems between the guide's table and the registered natives: each missing or unknown key. */
function tableProblems(markdown: string, keys: readonly string[]): string[] {
  const listed = [...tableRows(markdown).keys()];
  return [
    ...keys.filter((key) => !listed.includes(key)).map((key) => `guides/features.md: the native ${key} is missing from the table`),
    ...listed.filter((key) => !keys.includes(key)).map((key) => `guides/features.md: ${key} is in the table but is not a registered native`),
  ];
}

/** The page a site link points to. */
const pageOf = (link: string) => {
  const path = link.replace(/^\//, "").replace(/\/$/, "");
  return ["md", "mdx"].map((extension) => join(content, `${path}.${extension}`)).find((file) => existsSync(file));
};

describe("the native features guide", () => {
  test("its table lists exactly the registered natives", () => {
    expect(tableProblems(guide, registeredNatives().map((native) => native.key))).toEqual([]);
  });

  test("a native registered without a row fails, naming its key", () => {
    const audit = defineFeature({ key: "audit-trail", docs: { summary: "Test native." } });
    registerNative(audit);
    try {
      expect(tableProblems(guide, registeredNatives().map((native) => native.key))).toEqual(["guides/features.md: the native audit-trail is missing from the table"]);
    } finally {
      unregisterNative("audit-trail");
    }
  });

  test("security and http are on by default, the requirements are shown, and every row links to a guide and a reference page that exist", () => {
    const rows = tableRows(guide);
    for (const [key, cells] of rows) {
      expect(cells[2]).toBe(["security", "http", "dev", "deploy", "connections"].includes(key) ? "by default" : "by its key");
      const links = [...cells.join(" ").matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
      // realtime links both of its guides, Server-Sent Events and WebSockets.
      expect(links).toHaveLength(key === "realtime" ? 3 : 2);
      for (const link of links) expect(pageOf(link)).toBeDefined();
      expect(links.at(-1)).toBe(`/reference/features/${key}/`);
    }
    expect(rows.get("history")![3]).toBe("`events`");
    expect(rows.get("realtime")![3]).toContain("`events`");
    expect(rows.get("queues")![3]).toContain("`@publish` needs `events`");
    expect(guide).toContain("`<key>: false` or `QS_<KEY>_ENABLED=false`");
  });

  test("the infrastructure natives are listed with what enables them and what they work with", () => {
    const rows = tableRows(guide);
    for (const key of ["tenancy", "auth", "metrics", "proxy", "secrets"]) expect(rows.get(key)?.[2]).toBe("by its key");
    for (const key of ["auth", "secrets"]) expect(rows.get(key)![3]).toContain("`enables`");
    for (const key of ["queues", "events", "realtime"]) expect(rows.get("tenancy")![3]).toContain(`\`${key}\``);
    expect(rows.get("realtime")![1]).toContain("WebSockets");
    expect(rows.get("realtime")![4]).toBe("[Server-Sent Events](/guides/server-sent-events/), [WebSockets](/guides/websockets/)");
  });

  test("the guides index groups the infrastructure guides after the features guide", () => {
    const index = readFileSync(join(content, "guides/index.md"), "utf8");
    const group = index.split("Infrastructure:\n")[1]!.split("\n\n")[0]!;
    expect([...group.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1])).toEqual(["/guides/multi-tenancy/", "/guides/authentication/", "/guides/websockets/", "/guides/usage-metrics/", "/guides/api-gateway/", "/guides/mtls/", "/guides/secrets/"]);
    expect(index.indexOf("/guides/features/")).toBeLessThan(index.indexOf("Infrastructure:"));
  });

  test("the security guide links to the CSRF section of the authentication guide and to the mTLS guide", () => {
    const security = readFileSync(join(content, "guides/security.md"), "utf8");
    expect(security).toContain("(/guides/authentication/#csrf-for-cookie-sessions)");
    expect(security).toContain("(/guides/mtls/)");
  });

  test("it has the customization levels and links to the project features guide", () => {
    expect(guide).toContain("## The customization levels");
    for (const level of ["**Enable**", "**Options and environment**", "**Tags**", "**Per request**", "**Hooks and events**", "**Override files**", "**Replace the implementation**", "**Eject**"]) expect(guide).toContain(level);
    expect(guide).toContain("(/guides/project-features/)");
  });

  test("the README has a short Native features section linking to it, and the guides index lists it first", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const section = readme.split("## Native features\n")[1]!.split("\n## ")[0]!.trim().split("\n");
    expect(section.length + 1).toBeLessThanOrEqual(10);
    expect(section.join("\n")).toContain("(docs/src/content/docs/guides/features.md)");
    const index = readFileSync(join(content, "guides/index.md"), "utf8");
    const guides = [...index.matchAll(/^- \[[^\]]+\]\(([^)]+)\)/gm)].map((match) => match[1]);
    expect(guides[0]).toBe("/guides/features/");
    expect(guides).toContain("/guides/http-client/");
  });

  test("the core additions, the integrations group and the examples link to sections and files that exist", () => {
    const slug = (heading: string) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
    const additions = guide.split("## Core additions\n")[1]!.split("\n## ")[0]!.trim().split("\n");
    expect(additions.length).toBeLessThanOrEqual(6);
    const text = additions.join("\n");
    for (const name of ["`createFile`", "`openFile`", "`fileUrl`", "upload checks", "`@vector`", "`nearest()`", "Usage counters", "WebSocket routes at runtime"]) expect(text).toContain(name);
    const links = [...text.matchAll(/\]\(([^)#]+)#([^)]+)\)/g)];
    expect(links).toHaveLength(5);
    for (const [, page, anchor] of links) {
      const headings = readFileSync(pageOf(page!)!, "utf8").match(/^#{2,3} .+$/gm)!.map((line) => slug(line.replace(/^#+ /, "")));
      expect(headings).toContain(anchor!);
    }
    const index = readFileSync(join(content, "guides/index.md"), "utf8");
    expect(index.split("Integrations:\n\n")[1]!.split("\n\n")[0]).toBe("- [Webhooks](/guides/webhooks/)");
    expect(index.indexOf("Infrastructure:")).toBeLessThan(index.indexOf("Integrations:"));
    expect(tableRows(guide).get("webhooks")![3]).toContain("`enables`");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const examples = readme.split("## Examples\n")[1]!.split("\n## ")[0]!.trim().split("\n");
    expect(examples.length + 1).toBeLessThanOrEqual(8);
    const readmeLinks = [...examples.join("\n").matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    expect(readmeLinks).toEqual(["examples/identity/README.md", "examples/saas-projects/README.md"]);
    for (const link of readmeLinks) expect(existsSync(join(root, link))).toBe(true);
    const ending = guide.trim().split("\n## ").at(-1)!;
    expect(ending.startsWith("Examples\n")).toBe(true);
    const guideLinks = [...ending.matchAll(/\]\(https:\/\/github\.com\/ricardorauber\/quickservicets\/blob\/main\/([^)]+)\)/g)].map((match) => match[1]!);
    expect(guideLinks).toEqual(readmeLinks);
    expect(readme.split("## Native features\n")[1]!.split("\n## ")[0]).toContain("`webhooks`");
  });
});
