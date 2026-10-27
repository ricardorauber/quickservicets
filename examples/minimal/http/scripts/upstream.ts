/**
 * A tiny upstream for the example: `GET /quotes/random` answers a quote, and `GET /flaky` fails every other call with
 * 503. Run it with `bun scripts/upstream.ts` (port 4100, or PORT); the tests start it with `startUpstream()`.
 */
const QUOTES = ["Simple is better than complex.", "Make it work, make it right, make it fast.", "Programs must be written for people to read."];

/** Starts the upstream; `seen` lists the requests it received, with their headers. */
export function startUpstream(port = Number(process.env.PORT ?? 4100)) {
  const seen: { path: string; requestId: string | null; userId: string | null }[] = [];
  let flaky = 0;
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push({ path, requestId: request.headers.get("x-request-id"), userId: request.headers.get("x-user-id") });
      if (path === "/quotes/random") return Response.json({ text: QUOTES[Math.floor(Math.random() * QUOTES.length)] });
      if (path === "/flaky") return ++flaky % 2 === 1 ? Response.json({ error: "try again" }, { status: 503 }) : Response.json({ ok: true, attempts: flaky });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

export { QUOTES };

if (import.meta.main) {
  const upstream = startUpstream();
  console.log(`Quotes upstream listening on ${upstream.url}`);
}
