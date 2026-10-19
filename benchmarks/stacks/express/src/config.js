const env = process.env;
const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: int(env.PORT, 8080),
  /** Worker processes: one per CPU of the container (os.availableParallelism() does not see the --cpus quota). */
  workers: int(env.WORKERS, 2),
  /** Connections across all workers. */
  poolSize: int(env.DB_POOL_SIZE, 10),
  /** This worker's share of the pool, set by the primary. */
  workerPoolSize: int(env.WORKER_POOL_SIZE, int(env.DB_POOL_SIZE, 10)),
  uploadDir: env.UPLOAD_DIR || "./uploads",
  database: env.DATABASE_URL
    ? { connectionString: env.DATABASE_URL }
    : {
        host: env.DB_HOST || "localhost",
        port: int(env.DB_PORT, 5432),
        user: env.DB_USER || "bench",
        password: env.DB_PASSWORD || "bench",
        database: env.DB_NAME || "bench",
      },
};
