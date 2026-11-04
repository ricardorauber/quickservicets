/** The cron presets as five-field expressions. */
const PRESETS: Record<string, string> = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };

/** Seconds of an interval like `10m`, or undefined when it is not one. */
function intervalSeconds(every: string): number | undefined {
  const match = /^(\d+)(s|m|h|d)$/.exec(every.trim());
  if (!match) return undefined;
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as "s" | "m" | "h" | "d"];
}

/**
 * A job schedule as the six-field NCRONTAB of an Azure timer trigger (seconds first), or the reason it cannot be one:
 * cron strings get `0` seconds, presets their cron, and intervals that divide a minute, an hour or a day a step.
 */
export function ncrontab(schedule: unknown): { cron: string } | { error: string } {
  if (typeof schedule === "string") {
    const cron = PRESETS[schedule.trim()] ?? schedule.trim();
    const fields = cron.split(/\s+/);
    if (fields.length === 6) return { cron };
    if (fields.length === 5) return { cron: `0 ${cron}` };
    return { error: `${schedule} cannot be expressed as a cron for Azure Functions; use a cron schedule` };
  }
  const every = (schedule as { every?: string } | null)?.every;
  if (typeof every === "string") {
    const seconds = intervalSeconds(every);
    const fail = { error: `every ${every} cannot be expressed as a cron for Azure Functions; use a cron schedule` };
    if (seconds === undefined) return fail;
    if (seconds < 60 && 60 % seconds === 0) return { cron: `*/${seconds} * * * * *` };
    if (seconds % 60 === 0 && seconds < 3600 && 60 % (seconds / 60) === 0) return { cron: `0 */${seconds / 60} * * * *` };
    if (seconds % 3600 === 0 && seconds < 86_400 && 24 % (seconds / 3600) === 0) return { cron: `0 0 */${seconds / 3600} * * *` };
    if (seconds === 86_400) return { cron: "0 0 0 * * *" };
    return fail;
  }
  const at = (schedule as { at?: string } | null)?.at;
  return { error: `at ${String(at)} cannot be expressed as a cron for Azure Functions; use a cron schedule` };
}

/** The name of a job's timer function: `job-` and the job name with `/` as `-`. */
export const timerFunctionName = (job: string) => `job-${job.replaceAll("/", "-")}`;

/** A duration like `10m` as the `hh:mm:ss` of `host.json`. */
export function hostDuration(duration: string, parse: (text: string) => number | undefined): string {
  const total = Math.round((parse(duration) ?? 0) / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
