import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineCommand } from "../../packages/core/src/commands.ts";
import { defineFeature, registerNative, unregisterNative } from "../../packages/core/src/features.ts";
import { boolean, hook, integer, object, string, toggle } from "../../packages/core/src/options.ts";
import { configPage, featureApiMembers, featurePage, featuresIndex, referencePages, stalePages } from "../scripts/reference.ts";

const audit = (level = 1, extra: Record<string, unknown> = {}) =>
  defineFeature({
    key: "audit",
    docs: { summary: "Records who changed what." },
    options: object({
      level: integer().default(level).describe("How much is recorded."),
      log: toggle({ path: string().default("audit.log").describe("Where entries go.") }),
      beforeWrite: hook().describe("Runs before an entry is written."),
      afterWrite: hook().describe("Runs after an entry is written."),
    }),
    tags: { audit: { on: ["entity"], shorthand: "level", options: ["level"], description: "Sets the level of one entity.", example: "/** @audit 2 */" } },
    commands: [defineCommand({ name: "audit trail", description: "Prints the trail.", usage: "quickservicets audit trail", run: () => 0 })],
    ...extra,
  });

const registered: string[] = [];
const register = (definition: ReturnType<typeof audit>) => {
  registerNative(definition);
  registered.push(definition.key);
  return definition;
};
afterEach(() => {
  for (const key of registered.splice(0)) unregisterNative(key);
});

const tempContent = (pages: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "qs-pages-"));
  for (const [path, content] of Object.entries(pages)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

describe("feature pages", () => {
  test("the page has the summary, the enabling line and one options row per leaf with its variable", () => {
    const page = featurePage(register(audit()));
    expect(page).toContain("title: audit\ndescription: Records who changed what.");
    expect(page).toContain("```ts\naudit: {}\n```");
    expect(page).toContain("It is not enabled by default");
    expect(page).toContain("| `audit.level` | `integer` | `1` | `QS_AUDIT_LEVEL` | no | How much is recorded. |");
    expect(page).toContain("| `audit.log.enabled` | `boolean` | `true` | `QS_AUDIT_LOG_ENABLED` | no |");
    expect(page).toContain("| `audit.beforeWrite` | `hook` | — | not overridable | no |");
  });

  test("a native enabled by default says how to turn it off, and requirements are listed", () => {
    const page = featurePage(defineFeature({ key: "audit", docs: { summary: "S." }, enabledByDefault: true, requires: [{ name: "store", hint: "entries are stored" }], enables: ["store"] }));
    expect(page).toContain("It is enabled by default; turn it off with `audit: false` or `QS_AUDIT_ENABLED=false`.");
    expect(page).toContain("**Requires:** [`store`](/reference/features/store/) (entries are stored)");
    expect(page).toContain("**Enables:** `store`");
  });

  test("each external service the native needs has a Needs line, with optional when it applies", () => {
    const page = featurePage(
      audit(1, {
        infra: [
          { name: "redis", kind: "redis", description: "Cache", env: { REDIS_URL: "redis://{host}:{port}" } },
          { name: "mail", kind: "mailpit", description: "Mail", env: {}, optional: true },
        ],
      }),
    );
    expect(page).toContain("Needs: redis (redis)\n");
    expect(page).toContain("Needs: mail (mailpit, optional)\n");
    expect(page.indexOf("Needs: redis")).toBeLessThan(page.indexOf("## Options"));
    expect(featurePage(audit())).not.toContain("Needs:");
  });

  test("tags with their shorthand syntax, commands with their usage, and hooks with their kind", () => {
    const page = featurePage(audit());
    expect(page).toContain("### `@audit`");
    expect(page).toContain("**Syntax:** `@audit <level>` or `@audit off`");
    expect(page).toContain("**Options:** `audit.level`");
    expect(page).toContain("### `audit trail`\n\nPrints the trail.\n\n```bash\nquickservicets audit trail\n```");
    expect(page).toContain("| `audit.beforeWrite` | before | Runs before an entry is written. |");
    expect(page).toContain("| `audit.afterWrite` | after | Runs after an entry is written. |");
  });

  test("the feature API section lists the methods of the interface named in FeatureApis", () => {
    const dir = tempContent({
      "api.ts": [
        "export interface AuditApi {",
        "  /** Adds a hook after the config's. */",
        "  addHook(name: string, fn: () => void): void;",
        "}",
        'declare module "../public.ts" {',
        "  interface FeatureApis {",
        "    audit: AuditApi;",
        "  }",
        "}",
      ].join("\n"),
    });
    expect(featureApiMembers("audit", dir)).toEqual([{ name: "addHook", signature: "addHook(name: string, fn: () => void): void;", description: "Adds a hook after the config's." }]);
    const page = featurePage(audit(1, { api: () => ({}) }));
    expect(page).toContain("## Feature API");
    expect(page).toContain('`ctx.feature("audit")`');
  });
});

describe("index and links", () => {
  test("the index lists each native with a link, and the config reference links its section", () => {
    register(audit());
    expect(featuresIndex()).toContain("| [`audit`](/reference/features/audit/) | Records who changed what. | no |");
    expect(configPage()).toContain("Every option, tag, command and hook of `audit` is on [its reference page](/reference/features/audit/).");
    expect(Object.keys(referencePages())).toContain("reference/features/audit.mdx");
  });

  test("without natives the index says so and no feature page is generated", () => {
    expect(featuresIndex([])).toContain("No native features are registered.");
    expect(Object.keys(referencePages([])).filter((path) => path.startsWith("reference/features/"))).toEqual(["reference/features/index.md"]);
  });
});

describe("freshness", () => {
  test("a changed default and a page of a removed native are stale", () => {
    register(audit(1));
    const dir = tempContent(referencePages());
    expect(stalePages(referencePages(), dir)).toEqual([]);
    unregisterNative("audit");
    registerNative(audit(2));
    expect(stalePages(referencePages(), dir)).toEqual(["reference/config.mdx", "reference/features/audit.mdx"]);
    unregisterNative("audit");
    registered.splice(0);
    expect(stalePages(referencePages(), dir)).toEqual(["reference/config.mdx", "reference/cli.mdx", "reference/features/index.md", "reference/features/audit.mdx"]);
  });
});

describe("the events native", () => {
  test("its page lists the option variables, the @events tag, the hooks, the feature API and the commands", () => {
    const page = referencePages()["reference/features/events.mdx"]!;
    for (const text of ["`QS_EVENTS_OUTBOX_RETENTION`", "### `@events`", "| `events.beforeEmit` | before |", "## Feature API", "### `deliver`", "### `events outbox`", "### `events retry`"]) {
      expect(page).toContain(text);
    }
  });
});

describe("documentation rules", () => {
  test("a native needs a summary, and an undocumented option fails the generation naming the native", () => {
    expect(() => registerNative(defineFeature({ key: "audit" }))).toThrow("Native audit needs docs.summary for its reference page");
    const undocumented = register(defineFeature({ key: "audit", docs: { summary: "S." }, options: object({ level: integer().default(1) }) }) as never);
    expect(() => featurePage(undocumented)).toThrow("Native audit: audit.level has no description; add .describe(...)");
  });
});

describe("tag forms", () => {
  test("a tag's page shows one option in both forms, and a boolean option without a value", () => {
    const example = defineFeature({
      key: "example",
      docs: { summary: "Labels entities." },
      options: object({ label: string().default("Customer accounts").describe("The label."), hidden: boolean().default(false).describe("Hides the entity.") }),
      tags: {
        example: { on: ["entity"], options: ["label", "hidden"], description: "Labels one entity.", example: "/** @example.label Accounts */" },
        hide: { on: ["entity"], options: ["hidden"], scope: undefined, description: "Hides one entity.", example: "/** @hide.hidden */" },
      },
    });
    const page = featurePage(register(example as never));
    expect(page).toContain('**Forms:** `@example label="Customer accounts"` or `@example.label Customer accounts` set the same option');
    expect(page).toContain("**Forms:** `@hide hidden=true` or `@hide.hidden` set the same option");
  });
});
