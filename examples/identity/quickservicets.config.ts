import { defineConfig, postgresAdapter } from "@quickservicets/core";

export default defineConfig({
  database: postgresAdapter({ url: process.env.DATABASE_URL! }),
  // "profiles.permissions.module" has three segments.
  populate: { maxDepth: 3 },
  // security is on by default: headers, CORS, limits and rate limits (@rateLimit on the permission endpoints).
  // Write events, which history records, for every entity.
  events: {},
  // The versions of profiles, memberships and teams (@history): who held which permissions, and when.
  history: {},
  // GET /health/live and GET /health/ready, the latter checking the database.
  health: {},
  // A repeated POST /organizations with the same Idempotency-Key returns the first response (@idempotent).
  idempotency: {},
  // Detailed stats for organizations on the pro plan; req.tenant is set by the requires hook.
  flags: { rules: { "detailed-stats": ({ tenant }) => tenant?.plan === "pro" } },
});
