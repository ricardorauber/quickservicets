import type { Span, SpanAttributes, SpanAttributeValue, SpanContext, SpanKind, SpanLink, SpanOptions, Tracer } from "./tracing.ts";

/** A span the recording tracer created, with everything set on it. */
export interface RecordedSpan extends Span {
  name: string;
  kind: SpanKind;
  attributes: SpanAttributes;
  parent: SpanContext | null | undefined;
  links: readonly SpanLink[];
  events: { name: string; attributes?: SpanAttributes }[];
  exceptions: unknown[];
  status: { code: "ok" | "error"; message?: string } | undefined;
  ended: boolean;
  spanContext: SpanContext;
}

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A tracer keeping every span it starts, for tests. */
export function recordingTracer(): Tracer & { spans: RecordedSpan[]; named(name: string): RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  return {
    spans,
    named: (name) => spans.filter((span) => span.name === name),
    startSpan(name: string, options: SpanOptions): RecordedSpan {
      const parent = options.parent;
      const spanContext: SpanContext = { traceId: parent ? parent.traceId : hex(16), spanId: hex(8), traceFlags: 1 };
      const span: RecordedSpan = {
        name,
        kind: options.kind ?? "internal",
        attributes: { ...options.attributes },
        parent,
        links: options.links ?? [],
        events: [],
        exceptions: [],
        status: undefined,
        ended: false,
        spanContext,
        setAttribute(key: string, value: SpanAttributeValue) {
          span.attributes[key] = value;
          return span;
        },
        setAttributes(attributes: SpanAttributes) {
          Object.assign(span.attributes, attributes);
          return span;
        },
        addEvent(eventName: string, attributes?: SpanAttributes) {
          span.events.push({ name: eventName, ...(attributes ? { attributes } : {}) });
          return span;
        },
        recordException(error: unknown) {
          span.exceptions.push(error);
          span.events.push({ name: "exception" });
          return span;
        },
        setStatus(code: "ok" | "error", message?: string) {
          span.status = { code, ...(message !== undefined ? { message } : {}) };
          return span;
        },
        updateName(next: string) {
          span.name = next;
          return span;
        },
        end() {
          span.ended = true;
        },
        isRecording: () => true,
        context: () => spanContext,
      };
      spans.push(span);
      return span;
    },
  };
}

/** An instrument the recording meter created, with every value recorded through it. */
export interface RecordedInstrument {
  name: string;
  kind: "counter" | "upDownCounter" | "histogram" | "observableGauge";
  options: { description: string; unit: string; buckets?: readonly number[] };
  values: { value: number; attributes: Record<string, string | number | boolean> }[];
  callback?: (observe: (value: number, attributes?: Record<string, string | number | boolean>) => void) => void | Promise<void>;
  removed: boolean;
}

/** A meter keeping every instrument and value, for tests; `collect` runs a gauge's callback. */
export function recordingMeter() {
  const instruments: RecordedInstrument[] = [];
  const create = (kind: RecordedInstrument["kind"]) => (name: string, options: RecordedInstrument["options"], callback?: RecordedInstrument["callback"]) => {
    const instrument: RecordedInstrument = { name, kind, options, values: [], removed: false, ...(callback ? { callback } : {}) };
    instruments.push(instrument);
    const push = (value: number, attributes: Record<string, string | number | boolean> = {}) => void instrument.values.push({ value, attributes });
    return { add: push, record: push, remove: () => void (instrument.removed = true) };
  };
  return {
    instruments,
    counter: create("counter"),
    upDownCounter: create("upDownCounter"),
    histogram: create("histogram"),
    observableGauge: create("observableGauge"),
    named: (name: string) => instruments.find((instrument) => instrument.name === name),
    async collect(name: string) {
      const gauge = instruments.find((instrument) => instrument.name === name && !instrument.removed);
      const observed: { value: number; attributes: Record<string, string | number | boolean> }[] = [];
      await gauge?.callback?.((value, attributes = {}) => void observed.push({ value, attributes }));
      return observed;
    },
  };
}
