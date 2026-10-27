import { queue } from "@quickservicets/core";

/** Writes a notification about a project, in the tenant the message was added for. */
export default queue<{ projectId: string }>(async ({ payload, repos, tenant }) => {
  const project = await repos.projects.findById(payload.projectId);
  await repos.notifications.create({ message: `${tenant?.id}: ${project?.name ?? "unknown project"} changed` });
});
