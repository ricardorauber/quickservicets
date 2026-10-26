import { queue } from "@quickservicets/core";

/** Sends the welcome email of a user and records it; addresses at fail.test bounce. */
export default queue<{ userId: string }>(
  async ({ payload, repos, log }) => {
    const user = await repos.users.findById(payload.userId);
    if (!user) return { skipped: "unknown user" };
    if (user.email.endsWith("@fail.test")) throw new Error(`Mailbox ${user.email} rejected the message`);
    const sent = await repos.outboxes.create({ to: user.email, subject: `Welcome, ${user.name}!`, sentAt: new Date() });
    log.info("welcome email sent", { to: user.email });
    return { outboxId: sent.id };
  },
  { retries: 2, retryDelay: "10s", dedupeWindow: "1d" },
);
