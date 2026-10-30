import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { referencePages } from "../scripts/reference.ts";

const content = join(import.meta.dir, "../src/content/docs");
const guide = readFileSync(join(content, "guides/named-databases.md"), "utf8");
const example = join(import.meta.dir, "../../examples/named-databases");

describe("the named databases guide", () => {
  test("it covers every topic", () => {
    for (const topic of [
      "## When to split databases",
      "## Configuring them",
      "## Choosing a database: folder or `@database`",
      "## References across databases and what is not enforced",
      "## Delete rules",
      "not atomic",
      "## Transactions, sagas and the outbox",
      "CROSS_DATABASE_TRANSACTION",
      "## Where feature tables live",
      "`database` (`QS_<KEY>_DATABASE`)",
      "## Migrations per database",
      "## Tenancy per database",
      "## Health",
      "## Tests",
      "## Moving an entity between databases",
    ]) {
      expect(guide).toContain(topic);
    }
  });

  test("its samples are checked, and the configuration, migrations, tenancy and files guides and the index link it", () => {
    expect(guide.match(/^```ts check title="/gm)?.length).toBeGreaterThanOrEqual(5);
    for (const page of ["guides/configuration.md", "guides/migrations.md", "guides/multi-tenancy.md", "guides/files.md", "guides/index.md"]) {
      expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/named-databases/)");
    }
  });
});

describe("the reference and the agent topic", () => {
  test("the config reference documents databases, its two forms, tenancy, tenantConnection and the variable", () => {
    const config = referencePages()["reference/config.mdx"]!;
    const line = config.split("\n").find((row) => row.startsWith("| `databases` |"))!;
    for (const part of ["`QS_DATABASES_<NAME>_URL`", "an adapter, or `{ adapter, tenancy, tenantConnection }`", "`per-tenant`", "`shared`", "`tenantConnection`"]) expect(line).toContain(part);
  });

  test("the config-and-env topic has a Named databases section", () => {
    const topic = readFileSync(join(import.meta.dir, "../../packages/cli/agent-docs/config-and-env.md"), "utf8");
    expect(topic).toContain("## Named databases");
    expect(topic).toContain("QS_DATABASES_<NAME>_URL");
  });
});

describe("the example", () => {
  test("its README shows the commands and the variable", () => {
    const readme = readFileSync(join(example, "README.md"), "utf8");
    for (const command of ["migration add", "quickservicets migrate", "migrate --database orders", "migration list", "QS_DATABASES_ORDERS_URL"]) expect(readme).toContain(command);
  });
});
