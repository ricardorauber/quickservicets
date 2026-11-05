import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const content = join(import.meta.dir, "../src/content/docs");
const guide = readFileSync(join(content, "guides/cloud-triggers.md"), "utf8");

describe("the cloud triggers guide", () => {
  test("it covers trigger files, sources, function targets and polling, delivery, failures, batches, CloudEvents, writing a source, hints and every level", () => {
    for (const heading of ["## Trigger files", "## The handler context", "## Sources", "## CloudEvents", "## Function targets", "## Polling in servers", "## Delivery guarantees", "## Failures, retries and batches", "## Writing a source", "## Infrastructure hints", "## Testing triggers", "## Customization levels", "## Cloud source packages"]) {
      expect(guide).toContain(heading);
    }
    for (const item of [
      "at least once",
      "idempotent",
      "inbox",
      "TriggerDiscard",
      "retryDelay × 2^(attempt − 1)",
      "trigger.event.dead",
      "ordered",
      "batchItemFailures",
      "Eventarc",
      "Pub/Sub",
      "Event Grid",
      "WebHook-Allowed-Origin",
      "runTriggerSourceContract",
      "describe(ref)",
      "ctx.checkpoints",
      "QS_TRIGGERS_OVERRIDES_<NAME>_<OPTION>",
      "beforeHandle",
      "eject triggers",
      "examples/minimal/triggers",
    ]) {
      expect(guide).toContain(item);
    }
  });

  test("the deploy targets guide, the queues guide and the guides index link to it", () => {
    for (const page of ["guides/deploy-targets.md", "guides/queues.md", "guides/index.md"]) expect(readFileSync(join(content, page), "utf8")).toContain("(/guides/cloud-triggers/");
  });
});
