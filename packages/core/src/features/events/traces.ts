import type { AnyEvent, SpanContext } from "../public.ts";

/** The context of the span that created each event, while a tracer is set; listeners and outbox rows link to it. */
export const eventTraces = new WeakMap<AnyEvent, SpanContext>();
