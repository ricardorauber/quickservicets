import type { EntityModel, FieldModel, NestedFieldModel } from "../model.ts";
import type { JobTrigger } from "./job.ts";

export const JOB_RUN_STATUSES = ["running", "success", "failed", "timedOut", "skipped", "abandoned", "interrupted"] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

export const JOB_TRIGGERS: readonly JobTrigger[] = ["schedule", "manual", "code"];
export const JOB_LOG_LEVELS = ["info", "warn", "error"] as const;

/** One `ctx.log` line stored in a run record. */
export type JobRunLog = {
  level: (typeof JOB_LOG_LEVELS)[number];
  message: string;
  /** When the line was written, as an ISO 8601 date-time. */
  at: string;
  fields?: Record<string, unknown>;
};

/** The record of one job run, stored in the `job-runs` collection. */
export type JobRun = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  job: string;
  trigger: JobTrigger;
  scheduledAt: Date;
  attempt: number;
  status: JobRunStatus;
  startedAt: Date;
  finishedAt?: Date | null;
  durationMs?: number | null;
  heartbeatAt?: Date | null;
  result?: unknown;
  error?: { message: string; stack?: string | null } | null;
  logs: JobRunLog[];
};

const column = (field: NestedFieldModel): FieldModel => ({ ...field, storage: "column" });
const json = (field: NestedFieldModel): FieldModel => ({ ...field, storage: "json" });

const LOG_FIELDS: NestedFieldModel[] = [
  { name: "level", type: "enum", values: [...JOB_LOG_LEVELS], optional: false },
  { name: "message", type: "string", optional: false },
  { name: "at", type: "string", optional: false },
  { name: "fields", type: "json", optional: true },
];

const SYSTEM = ["id", "createdAt", "updatedAt"];

/** The built-in `JobRun` entity, part of the model of every project with jobs. */
export function jobRunEntity(): EntityModel {
  const fields: FieldModel[] = [
    column({ name: "job", type: "string", optional: false }),
    column({ name: "trigger", type: "enum", values: [...JOB_TRIGGERS], optional: false }),
    column({ name: "scheduledAt", type: "date", optional: false }),
    column({ name: "attempt", type: "number", optional: false, min: 1 }),
    column({ name: "status", type: "enum", values: [...JOB_RUN_STATUSES], optional: false }),
    column({ name: "startedAt", type: "date", optional: false }),
    column({ name: "finishedAt", type: "date", optional: true }),
    column({ name: "durationMs", type: "number", optional: true }),
    column({ name: "heartbeatAt", type: "date", optional: true }),
    json({ name: "result", type: "json", optional: true }),
    json({
      name: "error",
      type: "object",
      optional: true,
      fields: [
        { name: "message", type: "string", optional: false },
        { name: "stack", type: "string", optional: true },
      ],
    }),
    json({ name: "logs", type: "array", optional: false, items: { type: "object", fields: LOG_FIELDS } }),
  ];
  const include = [...SYSTEM, ...fields.map((field) => field.name)];
  return {
    key: "JobRun",
    entityName: "JobRun",
    schema: null,
    name: "job-runs",
    repoKey: "jobRuns",
    tableName: "job_runs",
    fields,
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: [] }, read: { include, exclude: [] } },
    indexes: [{ fields: ["job", "scheduledAt", "attempt"], unique: true }, { fields: ["job", "startedAt"] }],
    system: true,
  };
}
