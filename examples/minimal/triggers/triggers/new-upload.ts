import { testSource, trigger } from "@quickservicets/core";

/** Records every new object of the bucket as an Upload. */
export default trigger<{ key: string }>({
  source: testSource({ type: "storage.object.created" }),
  async handle({ event, repos, log }) {
    log.info("new upload", { key: event.data.key });
    await repos.uploads.create({ key: event.data.key });
  },
});
