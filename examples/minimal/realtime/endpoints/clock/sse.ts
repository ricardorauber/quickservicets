import { defineSse } from "@quickservicets/core";

/** Sends the server's time every second until the client disconnects. */
export default defineSse((stream) => {
  stream.send({ now: new Date().toISOString() });
  const timer = setInterval(() => stream.send({ now: new Date().toISOString() }), 1000);
  stream.signal.addEventListener("abort", () => clearInterval(timer));
});
