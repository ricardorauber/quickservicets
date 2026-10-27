import { defineSocket } from "@quickservicets/core";

/** What clients send: a line of chat (with an optional `id` to get an acknowledgment), or that they are typing. */
type In = { type: "say"; text: string } | { type: "typing" };
/** What the room receives. */
type Out = { type: "said"; text: string; from: string } | { type: "typing"; from: string };

/**
 * A chat room: every signed-in client joins `room:<roomId>` and hears the others.
 * @auth
 */
export default defineSocket<{ in: In; out: Out }>({
  open: (ws, ctx) => ws.subscribe(`room:${ctx.params.roomId}`),
  on: {
    say: (ws, message, ctx) => {
      ws.publish(`room:${ctx.params.roomId}`, { type: "said", text: message.text, from: ws.user!.id });
      // A message sent with an `id` gets { id, result } back.
      return { delivered: true };
    },
    typing: (ws, _message, ctx) => ws.publish(`room:${ctx.params.roomId}`, { type: "typing", from: ws.user!.id }),
  },
});
