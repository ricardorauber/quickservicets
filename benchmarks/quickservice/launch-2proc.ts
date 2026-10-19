// Experiment: runs two QuickService processes that share port 8080 through SO_REUSEPORT (Linux).
const workers = [0, 1].map(() => Bun.spawn(["bun", ".generated/server.ts"], { stdout: "inherit", stderr: "inherit", env: process.env }));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const worker of workers) worker.kill(signal);
  });
}
const codes = await Promise.all(workers.map((worker) => worker.exited));
process.exit(codes.some((code) => code !== 0) ? 1 : 0);
