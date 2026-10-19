// Entry point: the primary process forks one worker per CPU (WORKERS, 2 in the benchmark container) and the
// workers share the listening socket through Node's cluster module. The primary serves no requests.
import cluster from "node:cluster";
import { config } from "./config.js";

if (cluster.isPrimary) {
  const slots = new Map(); // worker id -> slot index, so a restarted worker gets the same pool share
  let stopping = false;

  const fork = (slot) => {
    const worker = cluster.fork({ WORKER_POOL_SIZE: String(poolShare(slot)) });
    slots.set(worker.id, slot);
  };
  for (let slot = 0; slot < config.workers; slot++) fork(slot);

  cluster.on("exit", (worker, code, signal) => {
    const slot = slots.get(worker.id);
    slots.delete(worker.id);
    if (stopping) {
      if (slots.size === 0) process.exit(0);
      return;
    }
    console.error(`worker ${worker.process.pid} exited (${signal ?? code}), restarting`);
    fork(slot);
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (slots.size === 0) process.exit(0);
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill("SIGTERM");
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  const { start } = await import("./worker.js");
  start();
}

/** Splits DB_POOL_SIZE across the workers so that the total is exactly DB_POOL_SIZE (5 + 5 for 10 and 2 workers). */
function poolShare(slot) {
  const base = Math.floor(config.poolSize / config.workers);
  return Math.max(1, base + (slot < config.poolSize % config.workers ? 1 : 0));
}
