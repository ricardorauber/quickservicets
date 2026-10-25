import { listen } from "@quickservice/core";

/** Writes an audit entry after every committed user change. */
export default listen("user.written", async (event, { repos }) => {
  await repos.auditEntries.create({ type: event.type, recordId: event.recordId, changed: event.changed });
});
