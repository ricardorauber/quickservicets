/** A small upstream for the gateway: the product catalog, answering with the path and headers it received. */
export function startCatalog(port = 4101) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/catalog/products") return Response.json([{ id: "p1", name: "Desk" }]);
      return Response.json({ path: `${url.pathname}${url.search}`, forwardedFor: request.headers.get("x-forwarded-for"), host: request.headers.get("host") }, { status: url.pathname.endsWith("/missing") ? 404 : 200 });
    },
  });
}

if (import.meta.main) {
  const server = startCatalog(Number(process.env.PORT ?? 4101));
  console.log(`catalog listening on http://127.0.0.1:${server.port}`);
}
