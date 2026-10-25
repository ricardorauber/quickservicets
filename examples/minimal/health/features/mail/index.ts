import { boolean, defineFeature, object } from "@quickservice/core";

/** A small feature that adds a readiness check for its mail server. */
export default defineFeature({
  key: "mail",
  docs: { summary: "Adds the mail.smtp readiness check." },
  after: ["health"],
  options: object({
    down: boolean().default(false).describe("Makes the check fail as if the mail server were unreachable."),
  }),
  setup(ctx) {
    ctx.feature("health").check(
      "smtp",
      async () => {
        if (ctx.options.down) throw new Error("SMTP server unreachable");
        return { host: "smtp.example.com" };
      },
      { critical: false },
    );
  },
});
