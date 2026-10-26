import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_COMMANDS, COMMANDS } from "../../packages/cli/src/commands.ts";
import { documentedEntityTags } from "../../packages/cli/src/entities/entity-tags.ts";
import { documentedFieldTags } from "../../packages/cli/src/entities/field-tags.ts";
import { documentedEndpointTags } from "../../packages/cli/src/hooks/endpoint-tags.ts";
import { defineFeature, registerNative, unregisterNative } from "../../packages/core/src/features.ts";
import { hook, object, string } from "../../packages/core/src/options.ts";
import { configKeys, configPage, CONTENT, REPO, referencePages, stalePages } from "../scripts/reference.ts";

const pages = referencePages();

describe("tags", () => {
  test("every registered tag has a description, targets and an example", () => {
    const undocumented = [...documentedEntityTags(), ...documentedFieldTags(), ...documentedEndpointTags()]
      .filter((tag) => !tag.description || !tag.appliesTo || !tag.example)
      .map((tag) => tag.name);
    expect(undocumented).toEqual([]);
  });

  test("the tags page lists them", () => {
    for (const tag of ["@unique", "@default", "@access", "@summary", "@onDelete", "@collection"]) expect(pages["reference/tags.mdx"]).toContain(`\`${tag}\``);
  });
});

describe("config", () => {
  test("every key is documented, with its type and default", () => {
    const keys = configKeys();
    expect(keys.filter((key) => !key.description).map((key) => key.path)).toEqual([]);
    const byPath = Object.fromEntries(keys.map((key) => [key.path, key]));
    for (const path of ["database", "server.port", "files.access", "populate.maxDepth", "repositories.toArrayMax"]) expect(byPath[path]).toBeDefined();
    expect(byPath["populate.maxDepth"]).toMatchObject({ type: "number", defaultValue: "2" });
    expect(pages["reference/config.mdx"]).toContain("| `repositories.toArrayMax` | `number` | 10000 |");
  });
});

describe("config variables", () => {
  test("each key shows its environment variable, or that it is not overridable", () => {
    const page = pages["reference/config.mdx"]!;
    expect(page).toContain("| `server.port` | `number` | 3000 | `QS_SERVER_PORT` (or `PORT`) |");
    expect(page).toContain("| `jobs.limits.logLines` | `number` | 500 | `QS_JOBS_LIMITS_LOG_LINES` |");
    expect(page).toContain("| `database` | `DatabaseAdapter` | — | not overridable |");
  });

  test("registered natives list their options with their variables", () => {
    const audit = defineFeature({ key: "audit", options: object({ greeting: string().default("Hello").describe("How entries start.") }), docs: { summary: "Records changes." } });
    registerNative(audit);
    try {
      const page = configPage();
      expect(page).toContain("### `audit`");
      expect(page).toContain('| `audit.greeting` | `string` | `"Hello"` | `QS_AUDIT_GREETING` | How entries start. |');
      expect(page).toContain("| `audit.enabled` | `boolean` | `true` | `QS_AUDIT_ENABLED` |");
      unregisterNative("audit");
      registerNative(defineFeature({ docs: { summary: "Test native." }, key: "audit", options: object({ greeting: string().default("Hi") }) }));
      expect(configPage()).not.toBe(page);
    } finally {
      unregisterNative("audit");
    }
    expect(configPage()).toBe(pages["reference/config.mdx"]!);
  });

  test("a native's tags are listed under its options with their targets and options", () => {
    const tags = { audit: { on: ["entity", "endpoint"] as const, options: ["greeting"], description: "Sets how one entity or route is audited.", example: '/** @audit greeting="Good day" */' } };
    registerNative(defineFeature({ docs: { summary: "Test native." }, key: "audit", options: object({ greeting: string().default("Hello") }), tags }));
    try {
      const page = configPage();
      const section = page.slice(page.indexOf("### `audit`"));
      expect(section).toContain("#### `@audit`\n\nSets how one entity or route is audited.\n\n**Applies to:** entities, endpoints\n\n**Options:** `greeting`");
      expect(section).toContain('```ts\n/** @audit greeting="Good day" */\n```');
      expect(section.indexOf("| `audit.greeting`")).toBeLessThan(section.indexOf("#### `@audit`"));
    } finally {
      unregisterNative("audit");
    }
  });
});

describe("hook options", () => {
  test("a hook option's row shows type hook and that it is not overridable", () => {
    registerNative(defineFeature({ key: "audit", options: object({ beforeWrite: hook().describe("Runs before each write.") }), docs: { summary: "Audits." } }));
    try {
      expect(configPage()).toContain("| `audit.beforeWrite` | `hook` | — | not overridable | Runs before each write. |");
    } finally {
      unregisterNative("audit");
    }
  });
});

describe("tag syntax", () => {
  test("a tag's syntax line shows its shorthand, and its options name their scoped paths", () => {
    const options = object({ rateLimit: object({ rate: string().default("100/min"), by: string().default("ip") }) });
    const tags = { limit: { on: ["endpoint"] as const, scope: "rateLimit", shorthand: "rate", options: ["rate", "by"], description: "Limits a route.", example: "/** @limit 10/min */" } };
    registerNative(defineFeature({ docs: { summary: "Test native." }, key: "guard", options, tags }));
    try {
      const section = configPage().slice(configPage().indexOf("#### `@limit`"));
      expect(section).toContain("**Options:** `rateLimit.rate`, `rateLimit.by`");
      expect(section).toContain("**Syntax:** `@limit <rate> [by=…]` or `@limit off`");
    } finally {
      unregisterNative("guard");
    }
  });
});

describe("cli", () => {
  test("every command the CLI handles is documented", () => {
    const handled = [...BUILT_IN_COMMANDS.map((command) => command.name), "--version"];
    expect([...new Set(handled)].sort()).toEqual(COMMANDS.map((command) => command.name).sort());
    for (const command of handled) expect(pages["reference/cli.mdx"]).toContain(`## \`${command}\``);
    for (const command of ["init", "dev", "build", "migrate", "migration add", "migration list", "migration remove", "migration script"]) {
      expect(pages["reference/cli.mdx"]).toContain(`## \`${command}\``);
    }
  });
});

test("the committed reference pages are up to date (run `bun run docs:reference`)", () => {
  expect(stalePages(pages)).toEqual([]);
});

describe("http, errors and api pages", () => {
  test("operators per type and paging limits", () => {
    const http = pages["reference/http.mdx"]!;
    expect(http).toMatch(/\| `string` \| [^\n]*`contains`[^\n]*`startsWith`/);
    expect(http).toMatch(/\| `refArray` \| [^\n]*`containsAny`[^\n]*`size`/);
    expect(http).toContain("Page size, 1–100 (default 20).");
  });

  test("error codes with their statuses", () => {
    const errors = pages["reference/errors.mdx"]!;
    for (const [status, code] of [["400", "VALIDATION_ERROR"], ["404", "NOT_FOUND"], ["409", "CONFLICT"], ["413", "PAYLOAD_TOO_LARGE"], ["415", "UNSUPPORTED_MEDIA_TYPE"]]) {
      expect(errors).toContain(`| ${status} | \`${code}\` |`);
    }
  });

  test("repository and query methods with signatures", () => {
    const api = pages["reference/api.mdx"]!;
    for (const method of ["where", "include", "findByIds", "all", "none", "not", "page", "create", "findById", "update", "replace", "delete"]) {
      expect(api).toContain(`### \`${method}\``);
    }
    expect(api).toContain("findByIds<const P extends readonly PopulatePath<R>[] = []>(ids: readonly string[]");
  });
});
