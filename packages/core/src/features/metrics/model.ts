import type { EntityModel, FieldModel, NestedFieldModel } from "../public.ts";

/** One stored usage series of one window and instance, as `repos.metricWindows` returns it. */
export type MetricWindow = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  /** `<hostname>:<pid>:<worker index>` of the worker that recorded it. */
  instance: string;
  resolution: "minute" | "hour";
  windowStart: Date;
  seriesKey: string;
  route?: string | null;
  tenant?: string | null;
  user?: string | null;
  requests: number;
  errors: number;
  clientErrors: number;
  /** The encoded latency sketch. */
  sketch: unknown;
};

const column = (field: NestedFieldModel): FieldModel => ({ ...field, storage: "column" });

/** The shared system entity of stored usage windows, part of the model while `metrics.store` is `"database"`. */
export function metricWindowEntity(): EntityModel {
  const fields: FieldModel[] = [
    column({ name: "instance", type: "string", optional: false }),
    column({ name: "resolution", type: "enum", values: ["minute", "hour"], optional: false }),
    column({ name: "windowStart", type: "date", optional: false }),
    column({ name: "seriesKey", type: "string", optional: false }),
    column({ name: "route", type: "string", optional: true }),
    column({ name: "tenant", type: "string", optional: true }),
    column({ name: "user", type: "string", optional: true }),
    column({ name: "requests", type: "number", optional: false, min: 0 }),
    column({ name: "errors", type: "number", optional: false, min: 0 }),
    column({ name: "clientErrors", type: "number", optional: false, min: 0 }),
    { name: "sketch", type: "json", optional: false, storage: "json" } as FieldModel,
  ];
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  return {
    key: "MetricWindow",
    entityName: "MetricWindow",
    schema: null,
    name: "metric-windows",
    repoKey: "metricWindows",
    tableName: "metric_windows",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["instance", "resolution", "windowStart", "seriesKey"], unique: true }, { fields: ["resolution", "windowStart"] }],
    system: true,
    tenancy: "shared",
  } as EntityModel;
}
