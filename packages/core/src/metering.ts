import { activeSetup } from "./setup-phase.ts";

/** Metric attribute values: bounded texts, numbers and booleans. */
export type MetricAttributes = Record<string, string | number | boolean>;

/** What every instrument takes. */
export interface InstrumentOptions {
  description: string;
  /** The unit, as UCUM writes it: `s`, `By`, `{request}`. */
  unit: string;
}

/** What a histogram takes besides the description and unit. */
export interface HistogramOptions extends InstrumentOptions {
  /** The bucket boundaries; the meter may use its own. */
  buckets?: readonly number[];
}

/** A value that only grows, like a count of answers. */
export interface Counter {
  add(value: number, attributes?: MetricAttributes): void;
}

/** A value that goes up and down, like the requests in progress. */
export interface UpDownCounter {
  add(value: number, attributes?: MetricAttributes): void;
}

/** A distribution of values, like request durations. */
export interface Histogram {
  record(value: number, attributes?: MetricAttributes): void;
}

/** A gauge read at collection time through its callback. */
export interface ObservableGauge {
  /** Stops calling the callback (optional). */
  remove?(): void;
}

/** Receives the values of an observable gauge at collection time. */
export type Observe = (value: number, attributes?: MetricAttributes) => void;

/** Creates instruments; a telemetry implementation (like an OpenTelemetry plugin) sets one with `setMeter`. */
export interface Meter {
  counter(name: string, options: InstrumentOptions): Counter;
  upDownCounter(name: string, options: InstrumentOptions): UpDownCounter;
  histogram(name: string, options: HistogramOptions): Histogram;
  /** The callback runs at collection time; a promise it returns is awaited by meters that can. */
  observableGauge(name: string, options: InstrumentOptions, callback: (observe: Observe) => void | Promise<void>): ObservableGauge;
}

/** What `setMeter` takes besides the meter. */
export interface MeterOptions {
  /** Adds the tenant id as `quickservicets.tenant` to the request, client and database instruments (default false). */
  tenantAttribute?: boolean;
}

/** The meter a feature set during setup, with the feature's key and its options. */
export interface MeterSetting {
  owner: string;
  meter: Meter;
  tenantAttribute: boolean;
}

const NOOP_INSTRUMENT = Object.freeze({ add() {}, record() {} });

/** The meter of a service without one: its instruments record nothing. */
export const noopMeter: Meter = Object.freeze({
  counter: () => NOOP_INSTRUMENT,
  upDownCounter: () => NOOP_INSTRUMENT,
  histogram: () => NOOP_INSTRUMENT,
  observableGauge: () => ({}),
});

/** The default buckets of duration histograms, in seconds. */
export const DURATION_BUCKETS: readonly number[] = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]);

/** The instruments the core and natives record, created once per meter. */
export interface CoreInstruments {
  serverDuration: Histogram;
  activeRequests: UpDownCounter;
  clientDuration: Histogram;
  databaseDuration: Histogram;
  jobDuration: Histogram;
  queueDuration: Histogram;
  rateLimited: Counter;
}

let current: MeterSetting | undefined;
let instruments: CoreInstruments | undefined;

/**
 * Sets the meter of the service, so the core and the natives record the standard measurements through it. Only one
 * feature may set it, during its setup.
 */
export function setMeter(meter: Meter, options: MeterOptions = {}): void {
  const setup = activeSetup();
  if (!setup) throw new Error("setMeter() is only available during feature setup");
  if (typeof meter?.histogram !== "function" || typeof meter.counter !== "function") throw new Error("setMeter() takes an object with counter, upDownCounter, histogram and observableGauge");
  const existing = setup.server.meter;
  if (existing) throw new Error(`A meter is already set by ${existing.owner}`);
  setup.server.meter = { owner: setup.feature, meter, tenantAttribute: options.tenantAttribute === true };
  configureMetrics(setup.server.meter);
}

/** Makes `setting` the meter of the running service (none without one); `createApp` calls it with the service's settings. */
export function configureMetrics(setting: MeterSetting | undefined): void {
  if (setting?.meter === current?.meter && setting?.tenantAttribute === current?.tenantAttribute) return;
  current = setting;
  instruments = undefined;
}

/** Whether a meter is set; instrumentation checks it before creating or recording anything. */
export function metricsEnabled(): boolean {
  return current !== undefined;
}

/** The service's meter, or the no-op meter without one. */
export function currentMeter(): Meter {
  return current?.meter ?? noopMeter;
}

/** Whether the tenant id is a metric attribute. */
export function tenantAttributeEnabled(): boolean {
  return current?.tenantAttribute === true;
}

/** The core's instruments, created on first use after a meter was set; call only while `metricsEnabled()`. */
export function coreInstruments(): CoreInstruments {
  if (instruments) return instruments;
  const meter = currentMeter();
  const seconds = (description: string): HistogramOptions => ({ description, unit: "s", buckets: DURATION_BUCKETS });
  instruments = {
    serverDuration: meter.histogram("http.server.request.duration", seconds("Duration of HTTP server requests.")),
    activeRequests: meter.upDownCounter("http.server.active_requests", { description: "Number of active HTTP server requests.", unit: "{request}" }),
    clientDuration: meter.histogram("http.client.request.duration", seconds("Duration of HTTP client requests.")),
    databaseDuration: meter.histogram("db.client.operation.duration", seconds("Duration of database client operations.")),
    jobDuration: meter.histogram("quickservicets.job.duration", seconds("Duration of job runs.")),
    queueDuration: meter.histogram("quickservicets.queue.message.duration", seconds("Duration of queue message runs.")),
    rateLimited: meter.counter("quickservicets.security.rate_limited", { description: "Requests answered 429 by a rate limit.", unit: "{request}" }),
  };
  return instruments;
}

/** The tenant attribute of a measurement, when the meter asked for it and the tenant is known. */
export function tenantAttributes(tenant: string | undefined): MetricAttributes {
  return tenant !== undefined && current?.tenantAttribute === true ? { "quickservicets.tenant": tenant } : {};
}
