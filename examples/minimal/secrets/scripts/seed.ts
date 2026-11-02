import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Creates the git-ignored secrets/ folder with the payments API key that file://secrets/api-key reads. */
const dir = join(import.meta.dir, "../secrets");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "api-key"), "example-payments-key\n");
console.log("Wrote secrets/api-key");
