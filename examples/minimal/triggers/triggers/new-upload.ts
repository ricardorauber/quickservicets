import { cloudEvents, trigger } from "@quickservicets/core";

/** Records every new object of the bucket as an Upload, from the CloudEvents the storage service pushes. */
export default trigger<{ key: string }>({
  source: cloudEvents({ type: "storage.object.created" }),
  async handle({ event, repos, log }) {
    log.info("new upload", { key: event.data.key });
    await repos.uploads.create({ key: event.data.key });
  },
});
