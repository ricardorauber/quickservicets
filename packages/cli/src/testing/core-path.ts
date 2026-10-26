import { join } from "node:path";

/** Absolute import specifier for @quickservicets/core, usable from fixture projects in temp folders. */
export const CORE_IMPORT = JSON.stringify(join(import.meta.dir, "../../../core/src/index.ts"));
