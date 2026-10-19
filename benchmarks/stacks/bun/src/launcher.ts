/**
 * Starts WORKERS (default 2, one per CPU of the container) copies of server.ts on the same port. Each worker binds
 * with `reusePort`, so the Linux kernel spreads incoming connections across them (SO_REUSEPORT). The DB_POOL_SIZE
 * connections are split between the workers, so the container never holds more than DB_POOL_SIZE in total.
 */
const WORKERS = Math.max(1, Number(process.env.WORKERS ?? 2));
const POOL_SIZE = Number(process.env.DB_POOL_SIZE ?? 10);
const script = Bun.resolveSync("./server", import.meta.dir);

let stopping = false;
const children = new Set<Bun.Subprocess>();

function spawn(index: number): void {
  // An even split; the first workers take the remainder (10 over 2 workers: 5 and 5).
  const poolSize = Math.floor(POOL_SIZE / WORKERS) + (index < POOL_SIZE % WORKERS ? 1 : 0);
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, WORKER_POOL_SIZE: String(poolSize) },
    stdio: ["ignore", "inherit", "inherit"],
    onExit(proc, code, signal) {
      children.delete(proc);
      if (stopping) {
        if (children.size === 0) process.exit(0);
        return;
      }
      console.error(`worker ${index} exited (code ${code}, signal ${signal}); restarting`);
      setTimeout(() => spawn(index), 100);
    },
  });
  children.add(child);
}

for (let index = 0; index < WORKERS; index++) spawn(index);

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  if (children.size === 0) process.exit(0);
  for (const child of children) child.kill(signal);
  setTimeout(() => process.exit(0), 9_000).unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
