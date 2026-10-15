import { expect, test } from "bun:test";
import { deriveCollectionName, pluralize, toCamelCase, toSnakeCase } from "./naming.ts";

test.each([
  ["Organization", "organizations"],
  ["BlogPost", "blog-posts"],
  ["Category", "categories"],
  ["Box", "boxes"],
  ["Day", "days"],
  ["Address", "addresses"],
  ["Match", "matches"],
  ["Wish", "wishes"],
  ["Quiz", "quizes"],
  ["UserProfileSetting", "user-profile-settings"],
])("%s derives collection %s", (entity, collection) => {
  expect(deriveCollectionName(entity)).toBe(collection);
});

test("pluralize keeps vowel + y", () => {
  expect(pluralize("key")).toBe("keys");
});

test("camel and snake derivations", () => {
  expect(toCamelCase("blog-posts")).toBe("blogPosts");
  expect(toSnakeCase("blog-posts")).toBe("blog_posts");
  expect(toCamelCase("users")).toBe("users");
});
