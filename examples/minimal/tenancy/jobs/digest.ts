import { job } from "@quickservicets/core";

/** Every day, for each active tenant, records how many projects it has. */
export default job(
  "@daily",
  async ({ repos }) => {
    await repos.digests.create({ projects: await repos.projects.count() });
  },
  { tenants: "each" },
);
