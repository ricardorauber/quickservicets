import { expect, test } from "bun:test";
import { join } from "node:path";
import { pagesUnder } from "../scripts/checks.ts";

const content = join(import.meta.dir, "../src/content/docs");

const PAGES = [
  "index.mdx",
  "getting-started/index.md",
  "getting-started/installation.md",
  "getting-started/first-entity.md",
  "getting-started/first-requests.md",
  "getting-started/project-structure.md",
  "tutorial/index.md",
  "tutorial/modules-and-permissions.md",
  "tutorial/profiles-and-organizations.md",
  "tutorial/users-memberships-and-teams.md",
  "tutorial/migrations-and-postgres.md",
  "tutorial/permission-endpoint.md",
  "tutorial/api-docs.md",
  "tutorial/testing.md",
  "guides/index.md",
  "guides/entities.md",
  "guides/enums.md",
  "guides/validation.md",
  "guides/field-selection.md",
  "guides/references.md",
  "guides/reference-arrays.md",
  "guides/relations.md",
  "guides/populate.md",
  "guides/endpoints.md",
  "guides/query-items.md",
  "guides/queries.md",
  "guides/hooks.md",
  "guides/files.md",
  "guides/migrations.md",
  "guides/api-docs.md",
  "guides/configuration.md",
  "reference/index.md",
  "reference/tags.mdx",
  "reference/config.mdx",
  "reference/cli.mdx",
  "reference/http.mdx",
  "reference/errors.mdx",
  "reference/api.mdx",
  "recipes/index.md",
  "recipes/permission-checks.md",
  "recipes/uploads-with-entities.md",
  "recipes/pagination.md",
  "recipes/multi-tenant.md",
  "recipes/testing.md",
];

test("every page of the site exists, in English only", () => {
  expect(pagesUnder(content)).toEqual([...PAGES].sort());
});
