import { cloudEvents, trigger } from "@quickservicets/core";

/** Logs every billing event; a real project would update its invoices. */
export default trigger<{ invoice?: string }>({
  source: cloudEvents({ type: "billing.*" }),
  handle({ event, log }) {
    log.info("billing event", { type: event.type, invoice: event.data.invoice });
  },
});
