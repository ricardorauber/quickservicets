import { expect, test } from "bun:test";
import { mockHttp } from "@quickservicets/core/testing";
import { startTestService } from "../testing/service.ts";

test("mockHttp() answers the outgoing calls of a project started with startTestService", async () => {
  const service = await startTestService({
    files: {
      "quickservicets.config.ts": `import { defineConfig, memoryAdapter } from "@quickservicets/core";
export default defineConfig({ database: memoryAdapter() });
`,
      "endpoints/weather/get.ts": `import type { Repositories, ServiceRequest } from "@quickservicets/core";
export default (_repos: Repositories, req: ServiceRequest) => req.http.get("https://weather.test/today").send();
`,
    },
  });
  const mock = mockHttp();
  try {
    mock.on("GET", "https://weather.test/today").reply(200, { sky: "clear" });
    expect(await (await service.fetch("/weather")).json()).toEqual({ sky: "clear" });
    expect(mock.calls).toHaveLength(1);
  } finally {
    mock.restore();
    await service.stop();
  }
});
