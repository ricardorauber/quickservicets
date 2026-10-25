import type { EntityTagger } from "@quickservice/core";

/** Tags a document with its version, like `"v3"`, in place of the default hash of its id and `updatedAt`. */
export const versionTagger: EntityTagger = {
  tag: (record) => `"v${String(record.version ?? 0)}"`,
};
