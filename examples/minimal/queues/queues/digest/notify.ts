import { queue } from "@quickservicets/core";

/** Replaces the `digest/notify` queue of the `digest` feature. */
export default queue<{ userId: string }>(() => ({ sentBy: "project" }));
