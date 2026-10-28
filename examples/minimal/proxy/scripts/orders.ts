import { proxyIdentity, type ServiceRequest } from "@quickservicets/core";

/**
 * The orders upstream of the gateway: it trusts only requests whose forwarded user and tenant carry the gateway's
 * signature, verified with `proxyIdentity`, as a QuickService.ts service behind the gateway would with one provider.
 */
export function startOrders(secret: string, port = 4102) {
  const verifier = proxyIdentity({ secret });
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/orders/slow") await Bun.sleep(500);
      let user: { id: string } | undefined;
      let tenant: { id: string } | undefined;
      try {
        const result = await verifier.authenticate({ method: request.method, path: url.pathname, headers: request.headers } as ServiceRequest);
        user = result?.user;
        tenant = result?.tenant;
      } catch {
        return Response.json({ error: "invalid identity" }, { status: 401 });
      }
      if (!user) return Response.json({ error: "no identity" }, { status: 401 });
      return Response.json({ orders: [{ id: "o1", total: 42 }], user: user.id, tenant: tenant?.id ?? null });
    },
  });
}

if (import.meta.main) {
  const secret = process.env.GATEWAY_SECRET;
  if (!secret) throw new Error("Set GATEWAY_SECRET, the same secret as the gateway's");
  const server = startOrders(secret, Number(process.env.PORT ?? 4102));
  console.log(`orders listening on http://127.0.0.1:${server.port}`);
}
