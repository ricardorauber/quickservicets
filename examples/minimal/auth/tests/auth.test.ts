import { expect, test } from "bun:test";
import { testAuth } from "@quickservicets/core/testing";
import { startTestService } from "@quickservicets/cli/testing";
import { checkExample, projectFiles } from "./support.ts";

test("the example answers 401, 403 and 201, serves GET /me and marks the OpenAPI document", async () => {
  const service = await startTestService({ files: projectFiles(), env: { API_KEY: "k-123" }, auth: testAuth() });
  try {
    await checkExample(service);
  } finally {
    await service.stop();
  }
});

test("the project's provider runs before a provider a project feature registers", async () => {
  const feature = `import { defineFeature } from "@quickservicets/core";
export default defineFeature({
  key: "other-key",
  enabledByDefault: true,
  requires: ["auth"],
  setup: (ctx) => ctx.feature("auth").provider({ name: "other", credentials: { headers: ["x-api-key"] }, authenticate: () => ({ user: { id: "other" }, method: "apiKey" }) }),
});
`;
  const service = await startTestService({ files: { ...projectFiles(), "features/other-key/index.ts": feature }, env: { API_KEY: "k-123" } });
  try {
    expect(await (await service.fetch("/me", { headers: { "x-api-key": "k-123" } })).json()).toMatchObject({ id: "api-client" });
  } finally {
    await service.stop();
  }
});

test("QS_AUTH_REQUIRED=true makes every route but the API docs need a user", async () => {
  const service = await startTestService({ files: projectFiles(), env: { API_KEY: "k-123", QS_AUTH_REQUIRED: "true" } });
  try {
    expect((await service.fetch("/openapi.json")).status).toBe(200);
    expect((await service.fetch("/posts")).status).toBe(401);
  } finally {
    await service.stop();
  }
});
