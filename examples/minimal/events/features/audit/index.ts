import { defineFeature, HttpError } from "@quickservice/core";

/** Ships the audit listener file `events/audit-log.ts`, and refuses users without an email inside the write. */
export default defineFeature({
  key: "audit",
  requires: ["events"],
  setup(ctx) {
    ctx.events.on(
      "user.created",
      (event) => {
        if (!event.after.email.includes("@")) throw new HttpError(400, "A user needs an email address");
      },
      { phase: "inTransaction" },
    );
  },
});
