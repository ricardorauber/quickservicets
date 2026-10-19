import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../packages/cli/src/commands.ts";
import { documentedEntityTags } from "../../packages/cli/src/entities/entity-tags.ts";
import { documentedFieldTags } from "../../packages/cli/src/entities/field-tags.ts";
import { documentedEndpointTags } from "../../packages/cli/src/hooks/endpoint-tags.ts";
import { configKeys, CONTENT, REPO, referencePages } from "../scripts/reference.ts";

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
    for (const path of ["database", "server.port", "files.access", "populate.maxDepth", "repositories.findAllMax"]) expect(byPath[path]).toBeDefined();
    expect(byPath["populate.maxDepth"]).toMatchObject({ type: "number", defaultValue: "2" });
    expect(pages["reference/config.mdx"]).toContain("| `repositories.findAllMax` | `number` | 10000 |");
  });
});

describe("cli", () => {
  test("every command the CLI handles is documented", () => {
    const run = readFileSync(join(REPO, "packages/cli/src/run.ts"), "utf8");
    const handled = [
      ...[...run.matchAll(/command === "([a-z-]+)"(?: && args\[1\] === "([a-z-]+)")?/g)].map(([, command, sub]) => (sub ? `${command} ${sub}` : command!)),
      "--version",
    ];
    expect([...new Set(handled)].sort()).toEqual(COMMANDS.map((command) => command.name).sort());
    for (const command of ["init", "dev", "build", "migrate", "migration add", "migration list", "migration remove", "migration script"]) {
      expect(pages["reference/cli.mdx"]).toContain(`## \`${command}\``);
    }
  });
});

test("the committed reference pages are up to date (run `bun run docs:reference`)", () => {
  const stale = Object.entries(pages)
    .filter(([path, content]) => {
      try {
        return readFileSync(join(CONTENT, path), "utf8") !== content;
      } catch {
        return true;
      }
    })
    .map(([path]) => path);
  expect(stale).toEqual([]);
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
    for (const method of ["where", "include", "findByIds", "all", "page", "create", "findById", "update", "replace", "delete"]) {
      expect(api).toContain(`### \`${method}\``);
    }
    expect(api).toContain("findByIds<const P extends readonly PopulatePath<R>[] = []>(ids: readonly string[]");
  });
});
