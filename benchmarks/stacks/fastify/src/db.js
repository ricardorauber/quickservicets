import pg from "pg";

/** A pool with this worker's share of the DB_POOL_SIZE connections. */
export function createPool(workers) {
  const total = Number(process.env.DB_POOL_SIZE ?? 10);
  const max = Math.max(1, Math.floor(total / workers));
  const connection = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 5432),
        user: process.env.DB_USER ?? "bench",
        password: process.env.DB_PASSWORD ?? "bench",
        database: process.env.DB_NAME ?? "bench",
      };
  return new pg.Pool({ ...connection, max, idleTimeoutMillis: 0 });
}

// Named (prepared) statements, one name per distinct SQL text. pg prepares each name once per connection.
// List queries are built from the query string, so the number of names is capped.
const MAX_STATEMENTS = 500;
const names = new Map();

/** A query config that runs as a prepared statement. */
export function prepared(text, values) {
  let name = names.get(text);
  if (name === undefined) {
    if (names.size >= MAX_STATEMENTS) return { text, values };
    name = `q${names.size}`;
    names.set(text, name);
  }
  return { name, text, values };
}
