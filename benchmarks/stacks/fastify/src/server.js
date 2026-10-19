// Entry point: the primary process forks one Fastify worker per CPU (2 in the benchmark) and they share port 8080
// through Node's cluster module. The 10 database connections are split between the workers.
import cluster from "node:cluster";
import process from "node:process";

const WORKERS = Math.max(1, Number(process.env.WEB_CONCURRENCY ?? 2));
const SHUTDOWN_TIMEOUT_MS = 8000;

if (cluster.isPrimary && WORKERS > 1) {
  let stopping = false;
  for (let i = 0; i < WORKERS; i++) cluster.fork();

  cluster.on("exit", (worker, code, signal) => {
    if (stopping) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    console.error(`worker ${worker.process.pid} exited (${signal ?? code}), starting a new one`);
    cluster.fork();
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill("SIGTERM");
    setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else {
  const { start } = await import("./app.js");
  await start(WORKERS);
}
