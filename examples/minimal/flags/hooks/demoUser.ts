import { definePreHook } from "@quickservice/core";

/**
 * A stand-in for authentication, for this demo only: it trusts the `x-user-id` header. A real project sets `req.user`
 * from a verified token or session instead.
 */
export default definePreHook((_repos, req) => {
  const id = req.headers.get("x-user-id");
  if (id) req.user = { id };
});
