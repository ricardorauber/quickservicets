import { expect, test } from "bun:test";

test("the package entry point can be imported", async () => {
  const module = await import("./index.ts");
  expect(module).toBeDefined();
});

test("database drivers load only when their adapter is created", async () => {
  // A fresh process, so modules other tests loaded do not count.
  const script = `
    const core = await import(${JSON.stringify(`${import.meta.dir}/index.ts`)});
    const loaded = (name) => Object.keys(require.cache).some((path) => path.includes("/node_modules/" + name + "/"));
    const report = { atStart: { mongodb: loaded("mongodb") } };
    core.postgresAdapter({ url: "postgres://localhost:1/none" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    report.withPostgres = { mongodb: loaded("mongodb") };
    core.mongodbAdapter({ url: "mongodb://localhost:1", database: "none" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    report.withMongodb = { mongodb: loaded("mongodb") };
    console.log(JSON.stringify(report));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: import.meta.dir });
  expect(child.stderr.toString()).toBe("");
  expect(JSON.parse(child.stdout.toString())).toEqual({
    atStart: { mongodb: false },
    withPostgres: { mongodb: false },
    withMongodb: { mongodb: true },
  });
});
