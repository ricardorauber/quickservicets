import { queue } from "@quickservicets/core";

/** Comments on the task that a reminder went out, in the workspace the message was added for. */
export default queue<{ taskId: string }>(async ({ payload, repos }) => {
  const task = await repos.tasks.findById(payload.taskId);
  if (task) await repos.comments.create({ task: task.id, authorId: "system", body: `Reminder sent: ${task.title}` });
});
