import { defineFeature, HttpError } from "@quickservice/core";

/** Writes an audit entry after every committed user change, and refuses users without an email inside the write. */
export default defineFeature({
  key: "audit",
  requires: ["events"],
  setup(ctx) {
    ctx.app.onStart(({ repos }) => {
      ctx.events.on("*", async (event) => {
        if (event.entity !== "User") return;
        await repos.auditEntries.create({ type: event.type, recordId: event.recordId, changed: event.changed });
      });
      ctx.events.on(
        "user.created",
        (event) => {
          if (!String(event.after?.email ?? "").includes("@")) throw new HttpError(400, "A user needs an email address");
        },
        { phase: "inTransaction" },
      );
    });
  },
});
