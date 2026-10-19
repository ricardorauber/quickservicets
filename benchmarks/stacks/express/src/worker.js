import express from "express";
import { config } from "./config.js";
import { pool } from "./db.js";
import { errorHandler, sendError } from "./errors.js";
import { media } from "./media.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export function createApp() {
  const app = express();
  app.set("x-powered-by", false);
  // No HTTP caching: every request reaches PostgreSQL (the benchmark contract), so no ETag computation either.
  app.set("etag", false);

  // Empty bodies are invalid JSON here (body-parser would otherwise turn them into {}).
  const json = express.json({
    strict: false,
    verify: (req, res, buffer) => {
      if (buffer.length === 0) throw new SyntaxError("Empty JSON body");
    },
  });

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });
  app.use("/users", json, users);
  app.use("/organizations", organizations);
  app.use("/media", media);

  app.use((req, res) => sendError(res, 404, "Route not found"));
  app.use(errorHandler);
  return app;
}

export function start() {
  const server = createApp().listen(config.port, "0.0.0.0");

  const stop = () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
