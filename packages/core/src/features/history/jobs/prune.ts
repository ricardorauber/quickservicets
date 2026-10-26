import { job } from "../../public.ts";
import { pruneRunningService } from "../prune.ts";

/** Deletes, every day, the versions older than the retention of their entity; one run across instances. */
export default job("@daily", (ctx) => pruneRunningService(ctx.signal));
