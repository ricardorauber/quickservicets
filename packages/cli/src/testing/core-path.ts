import { join } from "node:path";

/** Absolute import specifier for @quickservice/core, usable from fixture projects in temp folders. */
export const CORE_IMPORT = JSON.stringify(join(import.meta.dir, "../../../core/src/index.ts"));
