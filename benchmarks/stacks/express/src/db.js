import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  ...config.database,
  max: config.workerPoolSize,
  idleTimeoutMillis: 0, // keep the connections open between bursts
});

pool.on("error", (err) => console.error("idle database client error", err));

/** Runs a query and returns its rows. `name` makes it a prepared statement, reused per connection. */
export async function rows(text, values, name) {
  const result = await pool.query(name ? { name, text, values } : { text, values });
  return result.rows;
}

export const UNIQUE_VIOLATION = "23505";
