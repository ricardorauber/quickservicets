---
title: mTLS
description: Serve HTTPS from the service, ask callers for client certificates, restrict who may call with allowlists and the @mtls tag, take identities a proxy or mesh verified, present certificates on outgoing calls, and customize every step.
sidebar:
  order: 59
---

Mutual TLS (mTLS) proves both ends of a connection: the service shows its certificate to the caller, and the caller shows a client certificate the service checks against its own certificate authorities. It is how services inside a company prove who they are to each other without passwords or tokens. QuickService.ts covers the whole path: `server.tls` serves HTTPS, the `mtls` item of the `security` native asks for client certificates and exposes the verified identity as `req.client`, `mtls.forwarded` reads identities a proxy or service mesh verified, and `tls` on a named HTTP service presents a certificate on outgoing calls. The options, variables, tag and hooks are listed on the [security reference page](/reference/features/security/), and `server.tls` on the [configuration reference](/reference/config/).

The samples come from the example project `examples/minimal/security`: its `tests/mtls.test.ts` serves HTTPS with throwaway certificates created at test time, and `bun scripts/certs.ts` writes a local CA, a server certificate and the clients `billing` and `reports` to `certs/` (git-ignored) to try it by hand.

## Where to terminate TLS and mTLS

| Where | Choose it when | In the service |
| --- | --- | --- |
| A load balancer, ingress or CDN | The service runs behind one anyway, on most platforms | Nothing: plain HTTP behind the proxy, `security.proxy.trust` for the client address |
| A service mesh (Istio, Linkerd, Consul) or a proxy (Envoy, NGINX) | Many services need mTLS with automatic certificates and rotation | `security.mtls.forwarded` reads the identity the mesh verified |
| The service itself | No proxy in front: a VM, an edge box, a small deployment, or a policy that TLS ends at the process | `server.tls`, and `security.mtls` for client certificates |

A proxy or mesh is the usual answer: certificates are issued and rotated for every service at once (cert-manager or step-ca issue them; this guide only points to them), and the service keeps Bun's fastest serving path. Terminate in the service when there is nothing in front of it.

## Server certificates and reloads

`server.tls` serves HTTPS on the service's port; setting `cert` and `key` turns it on, as file paths or PEM text, and each key has its variable:

```ts
export default defineConfig({
  database: memoryAdapter(),
  server: { tls: { cert: "certs/server.crt", key: "certs/server.key", minVersion: "TLSv1.2" } },
});
```

```bash
QS_SERVER_TLS_CERT=/etc/tls/tls.crt QS_SERVER_TLS_KEY=/etc/tls/tls.key bun .generated/server.ts
```

At startup the service logs the certificate's subject, names and expiry, warns when it expires within `expiryWarning` (default 14 days) and fails on a key that does not match. The files are watched (`watch`, every `reloadInterval`, default one minute, and at once on `SIGHUP`): a renewed certificate reaches new connections without a restart, while open connections finish on the old one. A renewal that cannot be read is logged and the running certificate stays.

## Client certificates and modes

`security.mtls` asks every caller for a client certificate and verifies it against `ca`, the authorities client certificates must chain to:

```ts
export default defineConfig({
  database: memoryAdapter(),
  server: { tls: { cert: "certs/server.crt", key: "certs/server.key" } },
  security: { mtls: { ca: ["certs/ca.crt"], allow: ["CN=billing"] } },
});
```

- `mode: "required"` (the default) refuses the handshake of a caller without a valid certificate: the connection closes before any HTTP.
- `mode: "optional"` lets callers without a certificate in, with `req.client` unset; the `@mtls` tag then protects chosen routes.

A certificate that chains to `ca` but is not on the allowlist answers `403 Client certificate not allowed`, and the refusal is logged as `security.mtls.rejected` with its reason, subject and fingerprint.

## req.client

Every request with a verified certificate has `req.client`, read in endpoints, hooks, middlewares and jobs started by the request:

| Field | Value |
| --- | --- |
| `subject` | `{ commonName, organization, organizationalUnit }` |
| `issuer` | `{ commonName, organization }` |
| `san` | The subject alternative names: `{ dns, uri, email, ip }` |
| `fingerprint256` | The SHA-256 fingerprint, lowercase hex |
| `serialNumber` | The serial number, lowercase hex |
| `validFrom`, `validTo` | The validity, when the certificate itself is known |
| `source` | `tls` when the service verified it, `forwarded` when a trusted proxy did |
| `pem` | The certificate, when it is known |

Request logs and error reports carry the client's common name and fingerprint, never the certificate.

## Allowlist patterns

`allow` lists the identities admitted; an empty list admits every certificate that chains to `ca`. An entry matches when any of the certificate's identities matches:

| Entry | Matches |
| --- | --- |
| `CN=billing`, `O=Acme`, `OU=Payments` | A subject attribute, exactly |
| `dns:billing.internal`, `dns:*.internal` | A DNS name; `*.` matches one level of subdomains |
| `uri:spiffe://cluster.local/ns/billing/sa/billing` | A URI, like a SPIFFE ID |
| `uri:spiffe://cluster.local/ns/billing/*` | A URI prefix, like every workload of a namespace |
| `email:ops@example.com` | An email name |
| `sha256:<fingerprint>` | One exact certificate, for pinning |

`QS_SECURITY_MTLS_ALLOW=CN=billing,uri:spiffe://cluster.local/ns/reports/*` sets the list from the environment.

## The @mtls tag

In optional mode, `@mtls` requires a certificate on one route, or on each route of an entity: a call without one answers 401. `allow=` replaces the global allowlist there, and `@mtls off` skips the identity checks on a route. The example's sync endpoint takes calls from the billing service only:

```ts
/** @mtls allow=CN=billing */
const sync: Endpoint = (_repos, req) => ({ synced: true, by: req.client?.subject.commonName ?? null });
```

## Forwarded certificates

When a proxy or mesh terminates mTLS, it sends the verified identity in a header. `forwarded` reads it, so `req.client`, the allowlist and `@mtls` work the same:

```ts
security: {
  proxy: { trust: ["10.0.0.0/8"] },
  mtls: { mode: "optional", forwarded: { enabled: true, format: "xfcc" } },
},
```

- `format: "xfcc"` reads Envoy's `x-forwarded-client-cert` (Istio, Linkerd, Envoy); `format: "pem"` with `header: "x-ssl-client-cert"` reads NGINX's `$ssl_client_escaped_cert`.
- Only the proxies in `forwarded.trust` (by default `security.proxy.trust`) may send it. Any client can write a header: from every other peer the header is removed before the request reaches the application, and production warns once that an untrusted peer sent one. Trusting the header from anywhere would let any caller claim any identity.
- With `forwarded`, `server.tls` is not needed: the proxy speaks TLS, the service plain HTTP on its private network.

## Certificates for outgoing calls

A named HTTP service with `tls` presents a client certificate on every call to its origin, and only there: a redirect to another origin gets no certificate.

```ts
http: {
  services: {
    billing: {
      url: "https://billing.internal",
      tls: { cert: "certs/billing.crt", key: "certs/billing.key", ca: ["certs/ca.crt"] },
    },
  },
},
```

`QS_HTTP_SERVICES_BILLING_TLS_CERT` and `QS_HTTP_SERVICES_BILLING_TLS_KEY` point to other files, the files are re-read when they change (`http.tlsReloadInterval`), a handshake failure is the error code `TLS` and is never retried, and `rejectUnauthorized: false` is refused in production. Proxy routes to the service present the same certificate.

## Certificate identities as users

`certificateAuth` is an auth provider for requests with `req.client`: `user(client)` returns `{ id, roles }` or `null`, and the request is signed in with the method `certificate`. `@auth` and `@roles` then work for services as they do for people:

```ts
export default defineConfig({
  database: memoryAdapter(),
  auth: { providers: [certificateAuth({ user: (client) => ({ id: client.subject.commonName!, roles: ["service"] }) })] },
  security: { mtls: { mode: "optional", ca: ["certs/ca.crt"] } },
});
```

```ts
/** @roles service */
export default () => ({ synced: true });
```

A call with the billing certificate is the user `billing` with the role `service`; a call without a certificate answers 401.

## WebSockets

While the service verifies client certificates itself, socket routes are not available, and startup fails with `realtime.websockets is not available while the service verifies client certificates itself; terminate mTLS at a proxy and use security.mtls.forwarded`: the runtime cannot upgrade connections served on the client-certificate path. Terminate mTLS at a proxy and use `forwarded`, which keeps WebSockets, or serve sockets from a service without `mtls`.

## The cost of verifying in the service

Bun's server does not expose the client's certificate, so with `security.mtls` the service serves through Node's `node:tls` and `node:http` modules instead of Bun's native server. Every request then goes through a slower path: expect lower throughput and higher latency than plain HTTPS on the same machine, and run the benchmark of your own routes before choosing it for hot paths. `server.tls` alone, and `forwarded`, keep Bun's native server.

## Customization

Every level applies to mTLS:

- Level 0: `mtls` is the one security item that stays off; giving it `ca` with `server.tls` (or `forwarded`) turns it on.
- Level 1: every option has its variable: `QS_SECURITY_MTLS_ENABLED`, `QS_SECURITY_MTLS_MODE`, `QS_SECURITY_MTLS_CA`, `QS_SECURITY_MTLS_ALLOW` (comma-separated), `QS_SECURITY_MTLS_FORWARDED_ENABLED`, `QS_SECURITY_MTLS_FORWARDED_TRUST`, and `QS_SERVER_TLS_CERT`, `QS_SERVER_TLS_KEY`, `QS_SERVER_TLS_CA` for the server.
- Level 2: `@mtls`, `@mtls allow=…` and `@mtls off` on routes and entities.
- Level 3: `allow` can be a function of the request, its verified client and its tenant, so each tenant lists the identities it accepts; its entries are checked on every call:

```ts
security: {
  mtls: { ca: ["certs/ca.crt"], allow: ({ tenant }) => tenant?.attributes.clients?.split(",") ?? [] },
},
```

- Level 4: `beforeClient` runs after verification with `{ client, req }`, and may return a changed client or throw an `HttpError` to refuse; `onRejected` observes every refusal with `{ request, ip, route, reason, client }`, where `client` has the common name and fingerprint:

```ts
security: {
  mtls: {
    ca: ["certs/ca.crt"],
    beforeClient: ({ client }) => {
      if (client.validTo && client.validTo.getTime() - Date.now() < 86_400_000) throw new HttpError(403, "Certificate expires within a day");
    },
    onRejected: ({ reason, client }) => console.warn("mTLS refused", reason, client?.fingerprint256),
  },
},
```

- Level 5: not applicable; the native ships no files to override.
- Level 6: `verifier` runs after the chain check with the parsed client and the raw certificate, and returns `true` or a refusal reason, which answers 403; it is the place for revocation (a CRL or OCSP) and SPIFFE trust bundles. An object without `verify` fails startup with `Invalid security.mtls.verifier: …`.

```ts
const revoked = new Set(["4f3a…"]);
security: { mtls: { ca: ["certs/ca.crt"], verifier: { verify: ({ client }) => (revoked.has(client.serialNumber) ? "revoked" : true) } } },
```

- Level 7: `quickservicets eject security` copies the native, mTLS included, into `features/security/`; the example's mTLS test passes against the ejected copy.

## Testing

`createTestCertificates()` from `@quickservicets/core/testing` creates a test CA, a `localhost` server certificate and client certificates with `openssl` in a temporary folder, once per test run, so no private key is committed. `service.listen()` from `startTestService` opens the HTTPS port, and Bun's `fetch` presents a client certificate with `tls: { ca, cert, key }`:

```ts
const certs = createTestCertificates();
const response = await fetch(`https://localhost:${port}/whoami`, { tls: { ca: certs.ca.certPem, cert: certs.billing.certPem, key: certs.billing.keyPem } });
```
