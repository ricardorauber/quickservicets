import { queue } from "@quickservice/core";

/** The feature's own consumer, replaced by the project's `queues/digest/notify.ts`. */
export default queue<{ userId: string }>(() => ({ sentBy: "feature" }));
