import { describe, expect, test } from "bun:test";
import type { BuildSummary } from "../build/build.ts";
import { PENDING_MIGRATION_WARNING } from "../build/build.ts";
import { debounce, type Scheduler } from "./debounce.ts";
import { DEBOUNCE_MS, handleSignals, startDev, type DevDependencies } from "./dev.ts";

function manualScheduler() {
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  const scheduler: Scheduler = {
    setTimeout: (callback, ms) => {
      timers.set(next, { at: now + ms, callback });
      return next++;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return { scheduler, advance };
}

const summary = (warnings: string[] = []): BuildSummary => ({ entities: 1, endpoints: 0, hooks: 0, warnings });

function fakeDependencies(overrides: Partial<DevDependencies> = {}) {
  const events: string[] = [];
  let onChange: () => void = () => {};
  const { scheduler, advance } = manualScheduler();
  let servers = 0;
  const deps: Partial<DevDependencies> = {
    build: async () => {
      events.push("build");
      return summary();
    },
    autoMigrationsEnabled: async () => true,
    addAutomaticMigration: async () => undefined,
    startServer: () => {
      const id = ++servers;
      events.push(`start ${id}`);
      return { stop: async () => void events.push(`stop ${id}`) };
    },
    watch: (_, __, callback) => {
      onChange = callback;
      events.push("watch");
      return { close: () => void events.push("close watcher") };
    },
    scheduler,
    log: (line) => events.push(`log ${line}`),
    error: (line) => events.push(`error ${line}`),
    ...overrides,
  };
  return { deps, events, change: () => onChange(), advance };
}

test("debounce collapses a burst of triggers into one call", () => {
  const { scheduler, advance } = manualScheduler();
  let calls = 0;
  const trigger = debounce(() => calls++, 200, scheduler);
  trigger();
  advance(100);
  trigger();
  advance(150);
  trigger();
  advance(199);
  expect(calls).toBe(0);
  advance(1);
  expect(calls).toBe(1);
});

describe("dev session", () => {
  test("builds, starts the server and restarts once per burst of changes", async () => {
    const { deps, events, change, advance } = fakeDependencies();
    const session = await startDev("/project", deps);
    const built = "log Built 1 entity, 0 custom endpoints and 0 hooks.";
    expect(events).toEqual(["build", built, "start 1", "watch"]);
    change();
    change();
    change();
    advance(DEBOUNCE_MS);
    await session.idle();
    expect(events).toEqual(["build", built, "start 1", "watch", "build", built, "stop 1", "start 2"]);
  });

  test("a failed rebuild prints the error and keeps the previous server", async () => {
    let fail = false;
    const { deps, events, change, advance } = fakeDependencies({
      build: async () => {
        if (fail) throw new Error("entities/User.ts: syntax error");
        return summary();
      },
    });
    const session = await startDev("/project", deps);
    fail = true;
    change();
    advance(DEBOUNCE_MS);
    await session.idle();
    expect(events).toEqual(["log Built 1 entity, 0 custom endpoints and 0 hooks.", "start 1", "watch", "error entities/User.ts: syntax error"]);
    fail = false;
    change();
    advance(DEBOUNCE_MS);
    await session.idle();
    expect(events.slice(-2)).toEqual(["stop 1", "start 2"]);
  });

  describe("automatic migrations", () => {
    const pending = async () => summary([PENDING_MIGRATION_WARNING]);
    test("are created and announced when enabled", async () => {
      const { deps, events } = fakeDependencies({
        build: pending,
        addAutomaticMigration: async () => ({
          id: "20261015120000_AddAgeToUsers",
          file: "migrations/20261015120000_AddAgeToUsers.ts",
          snapshot: "x",
        }),
      });
      await startDev("/project", deps);
      expect(events).toContain(
        'log Created migrations/20261015120000_AddAgeToUsers.ts. Run "quickservicets migrate" to apply it.',
      );
    });
    test("only warn when disabled", async () => {
      let created = false;
      const { deps, events } = fakeDependencies({
        build: pending,
        autoMigrationsEnabled: async () => false,
        addAutomaticMigration: async () => {
          created = true;
          return undefined;
        },
      });
      await startDev("/project", deps);
      expect(created).toBe(false);
      expect(events).toContain(`error Warning: ${PENDING_MIGRATION_WARNING}`);
    });
  });

  test("signals stop the server and the watcher, then exit 0", async () => {
    const { deps, events } = fakeDependencies();
    const session = await startDev("/project", deps);
    const handlers = new Map<string, () => Promise<void>>();
    let exitCode: number | undefined;
    handleSignals(session, {
      once: ((signal: string, handler: () => Promise<void>) => handlers.set(signal, handler)) as never,
      exit: ((code: number) => {
        exitCode = code;
      }) as never,
    });
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    await handlers.get("SIGTERM")!();
    expect(events.slice(-2)).toEqual(["close watcher", "stop 1"]);
    expect(exitCode).toBe(0);
  });
});
