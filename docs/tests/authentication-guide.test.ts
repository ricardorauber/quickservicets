import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const example = join(import.meta.dir, "../../examples/minimal/auth");
const guide = readFileSync(join(content, "guides/authentication.md"), "utf8");

/** The `ts` code blocks of a page that carry a title, by title. */
function titledSamples(markdown: string): Map<string, string> {
  const samples = new Map<string, string>();
  for (const match of markdown.matchAll(/^```ts title="([^"]+)"\n([\s\S]*?)\n```$/gm)) samples.set(match[1]!, `${match[2]}\n`);
  return samples;
}

describe("the authentication guide", () => {
  test("its file samples are the example project's files", () => {
    const samples = titledSamples(guide);
    expect([...samples.keys()].sort()).toEqual(["endpoints/me/get.ts", "entities/Post.ts", "lib/api-key.ts", "quickservicets.config.ts"]);
    for (const [path, code] of samples) expect(code).toBe(readFileSync(join(example, path), "utf8"));
  });

  test("it covers every topic", () => {
    for (const topic of [
      "## The contract and req.user",
      "## Writing a provider",
      "## @auth, @roles and their operations",
      "## Scopes",
      "## The 401 and 403 answers",
      "## OpenAPI security",
      "## The account protection kit",
      "loginGuard",
      "invalidCredentials",
      "## CSRF for cookie sessions",
      "## Revocation",
      "## Tenancy and credentials",
      "## Customization",
      "Level 7",
      "## Testing with testAuth()",
    ]) {
      expect(guide.includes(topic) ? topic : `missing ${topic}`).toBe(topic);
    }
  });

  test("it is in the Guides sidebar, and the configuration guide, the guides index and the features table link to it", () => {
    expect(guide).toMatch(/^sidebar:\n {2}order: \d+$/m);
    for (const page of ["guides/configuration.md", "guides/index.md", "guides/features.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/authentication/)");
  });

  test("the reference page lists QS_AUTH_REQUIRED, both tags and the hooks", () => {
    const reference = readFileSync(join(content, "reference/features/auth.mdx"), "utf8");
    for (const text of ["QS_AUTH_REQUIRED", "### `@auth`", "### `@roles`", "`auth.beforeUser`", "`auth.onAuthenticated`", "`auth.onAuthFailed`", "`auth.beforeAuthorize`", "no files to override"]) {
      expect(reference.includes(text) ? text : `missing ${text}`).toBe(text);
    }
  });
});
