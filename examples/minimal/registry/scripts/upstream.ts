/**
 * A billing instance for the example: answers `GET /invoices` with its version, and `/health/ready` with 200, or 503
 * while it fails on demand (`POST /fail` and `POST /recover`, or `FAIL=1`).
 *
 *   PORT=4101 VERSION=1.4.0 bun scripts/upstream.ts
 *   PORT=4102 VERSION=2.1.0 bun scripts/upstream.ts
 */
export function startUpstream(options: { port?: number; version: string; failing?: boolean }) {
  let failing = options.failing ?? false;
  const server = Bun.serve({
    port: options.port ?? 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/fail") return (failing = true), new Response(null, { status: 204 });
      if (request.method === "POST" && path === "/recover") return (failing = false), new Response(null, { status: 204 });
      if (failing) return Response.json({ error: "failing on demand" }, { status: 503 });
      if (path === "/health/ready") return Response.json({ status: "ok" });
      return Response.json({ version: options.version, invoices: [{ id: "inv_1", total: 42 }] });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    port: server.port!,
    fail: () => void (failing = true),
    recover: () => void (failing = false),
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const upstream = startUpstream({ port: Number(process.env.PORT ?? 4101), version: process.env.VERSION ?? "2.1.0", failing: process.env.FAIL === "1" });
  console.log(`billing ${process.env.VERSION ?? "2.1.0"} on ${upstream.url}`);
}
