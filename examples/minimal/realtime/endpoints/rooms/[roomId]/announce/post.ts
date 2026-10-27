import { sockets, type Endpoint } from "@quickservicets/core";

/** @summary Sends an announcement to everyone in a room */
const handler: Endpoint<{ text: string }, { sent: true }> = async (_repos, req) => {
  const { text } = await req.json();
  sockets.publish(`room:${req.params.roomId}`, { type: "said", text, from: "announcer" });
  return { sent: true };
};

export default handler;
