import { job } from "../../public.ts";
import { rollupStoredWindows } from "../index.ts";

/** Every hour, rolls the stored minute windows older than the retention into hour windows and prunes old hour windows. */
export default job("@hourly", () => rollupStoredWindows());
