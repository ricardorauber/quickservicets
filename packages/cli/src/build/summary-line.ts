import type { BuildSummary } from "./build.ts";

/** `1 entity`, `0 entities`, `2 entities`: the build summary counts the entities really in the model. */
export const entityCount = (count: number): string => `${count} ${count === 1 ? "entity" : "entities"}`;

/** The line `build` prints, like `Built 1 entity, 0 custom endpoints and 0 hooks.` */
export function buildSummaryLine(summary: Pick<BuildSummary, "entities" | "endpoints" | "hooks" | "features">): string {
  return (summary.features ?? 0) > 0
    ? `Built ${entityCount(summary.entities)}, ${summary.endpoints} custom endpoints, ${summary.hooks} hooks and ${summary.features} project features.`
    : `Built ${entityCount(summary.entities)}, ${summary.endpoints} custom endpoints and ${summary.hooks} hooks.`;
}
