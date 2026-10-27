import { defineFeature } from "@quickservicets/core";

/**
 * A stand-in for authentication, for this demo only: it trusts the `x-user-id` header, so calls to the quotes service
 * propagate the user. A real project sets `req.user` from a verified token or session instead.
 */
export default defineFeature({
  key: "demo-user",
  middleware: [
    {
      stage: "handler",
      order: -60_000,
      run: (req, _res, next) => {
        const id = req.headers.get("x-user-id");
        if (id) req.user = { id };
        return next();
      },
    },
  ],
});
