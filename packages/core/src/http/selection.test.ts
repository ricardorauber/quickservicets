import { expect, test } from "bun:test";
import { populatedPrefixes } from "./selection.ts";

test("every prefix of a populate path counts as populated", () => {
  expect(populatedPrefixes(["organization.country"])).toEqual(["organization", "organization.country"]);
  expect(populatedPrefixes(["profiles.permissions.module", "profiles", "team"])).toEqual([
    "profiles",
    "profiles.permissions",
    "profiles.permissions.module",
    "team",
  ]);
  expect(populatedPrefixes([])).toEqual([]);
});
