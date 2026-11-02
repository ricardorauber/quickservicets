import { env } from "@quickservicets/core";

/** Tells whether the API key resolved, without ever answering it. */
export default () => ({ apiKey: env.API_KEY ? "resolved" : "missing", length: env.API_KEY?.length ?? 0 });
