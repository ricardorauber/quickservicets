import { runningTriggers } from "../features/triggers/index.ts";
import type { EmitTriggerOptions, TriggerEmission } from "../features/triggers/state.ts";
import type { TriggerName, TriggerNames } from "../features/triggers/trigger.ts";

/**
 * Runs the trigger `name` of the running service with one event carrying `data` (for a trigger with `batch: true`, an
 * array of data is one delivery of one event per item), as a delivery would, and resolves its outcome: `status`
 * (`failed` when any event failed), the first event's id and error, and every outcome. Rejects with
 * `Unknown trigger <name>` for a name that is not a trigger, and while the `triggers` native does not run.
 */
export async function emitTrigger<N extends TriggerName>(name: N, data: TriggerNames[N], options: EmitTriggerOptions = {}): Promise<TriggerEmission> {
  return runningTriggers().emit(name, data, options);
}
