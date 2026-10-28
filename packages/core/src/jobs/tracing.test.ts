import { afterEach, expect, test } from "bun:test";
import "../index.ts";
import { configureTracing, startSpan, withSpan } from "../tracing.ts";
import { recordingTracer } from "../tracing-test-support.ts";
import { job } from "./job.ts";
import { connectedMemory, jobInstance, START } from "./test-support.ts";
import { createRequestJobs } from "./triggers.ts";

afterEach(() => configureTracing(undefined));

test("a scheduled run starts a root consumer span, and a run started from a request links to the request's span", async () => {
  const tracer = recordingTracer();
  configureTracing({ owner: "test", tracer });
  const database = await connectedMemory();
  const { runner, clock, logger } = jobInstance({ nightly: job({ every: "1h" }, async () => "done"), failing: job({ every: "1h" }, async () => { throw new Error("nope"); }) }, database);
  await runner.run({ job: "nightly", trigger: "schedule", scheduledAt: new Date(START), attempt: 1 });
  const scheduled = tracer.named("job nightly")[0]!;
  expect(scheduled.kind).toBe("consumer");
  expect(scheduled.parent).toBeNull();
  expect(scheduled.links).toEqual([]);
  expect(scheduled.ended).toBe(true);
  expect(scheduled.attributes).toMatchObject({ "quickservicets.job.name": "nightly", "quickservicets.job.attempt": 1, "quickservicets.job.status": "success" });
  expect(typeof scheduled.attributes["quickservicets.job.run_id"]).toBe("string");

  const request = startSpan("GET /trigger", { kind: "server" });
  await withSpan(request, () => createRequestJobs(runner, { logger, clock }).run("nightly" as never));
  await runner.idle();
  const triggered = tracer.named("job nightly")[1]!;
  expect(triggered.parent).toBeNull();
  expect(triggered.links.map((link) => link.context)).toEqual([request.context()]);

  await runner.run({ job: "failing", trigger: "schedule", scheduledAt: new Date(START), attempt: 1 });
  expect(tracer.named("job failing")[0]!.status?.code).toBe("error");
});
