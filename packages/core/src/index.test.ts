import { expect, test } from "bun:test";

test("the package entry point can be imported", async () => {
  const module = await import("./index.ts");
  expect(module).toBeDefined();
});
