import { afterEach, describe, expect, test } from "bun:test";
import "./index.ts";
import { registerProjectFeatures } from "./features.ts";
import { startTestApp, type TestApp } from "./tenancy-test-support.ts";
import { cloudEvents, cloudEventsSource, http, securityFeature, trigger, type ServiceRequest, type TriggerEvent } from "./index.ts";

const started: TestApp[] = [];
afterEach(async () => {
  for (const app of started.splice(0)) await app.stop();
  registerProjectFeatures([]);
});

const start = async (triggers: Record<string, unknown>, config: Record<string, unknown> = {}) => {
  const app = await startTestApp({ config: { triggers: {}, ...config }, featureFolders: { triggers: { triggers: new Map(Object.entries(triggers)) } } });
  started.push(app);
  return app;
};

const binary = (headers: Record<string, string>, body: unknown = { bucket: "photos", name: "a.png" }) => ({
  method: "POST",
  headers: { "content-type": "application/json", "ce-specversion": "1.0", "ce-id": "evt-1", "ce-source": "//storage.googleapis.com/projects/_/buckets/photos", "ce-type": "google.cloud.storage.object.v1.finalized", ...headers },
  body: JSON.stringify(body),
});
const structured = (event: Record<string, unknown>) => ({ id: "s-1", specversion: "1.0", source: "/billing", type: "billing.invoice.paid", data: { amount: 10 }, ...event });

describe("references and matching", () => {
  test("cloudEvents() makes a cloudevents reference matching type and source exactly or by prefix", () => {
    const ref = cloudEvents({ type: "google.cloud.storage.object.v1.*", source: "//storage.googleapis.com/*" });
    expect(ref).toEqual({ kind: "cloudevents", type: "google.cloud.storage.object.v1.*", source: "//storage.googleapis.com/*" });
    const event = (type: string, source: string): TriggerEvent => ({ id: "1", kind: "cloudevents", type, time: new Date(), data: undefined, attributes: { source }, attempt: 1 });
    expect(cloudEventsSource.matches(ref, event("google.cloud.storage.object.v1.finalized", "//storage.googleapis.com/b"))).toBe(true);
    expect(cloudEventsSource.matches(ref, event("google.cloud.pubsub.topic.v1.messagePublished", "//storage.googleapis.com/b"))).toBe(false);
    expect(cloudEventsSource.matches(cloudEvents({ type: "billing.paid" }), event("billing.paid.late", "/x"))).toBe(false);
    expect(cloudEventsSource.matches(cloudEvents(), event("anything", "/x"))).toBe(true);
  });
});

describe("decoding", () => {
  test("a binary event of the matching type runs the trigger on POST /_triggers/<name> with the parsed data, and answers 204", async () => {
    const seen: TriggerEvent[] = [];
    const app = await start({ "uploads/finalized": trigger({ source: cloudEvents({ type: "google.cloud.storage.object.v1.*" }), handle: ({ event }) => void seen.push(event) }) });
    expect(app.lifecycle.routes.map((route) => `${route.method} ${route.path}`)).toEqual(["POST /_triggers/uploads/finalized", "OPTIONS /_triggers/uploads/finalized"]);
    const response = await app.fetch("/_triggers/uploads/finalized", binary({ "ce-subject": "objects/a.png", "ce-time": "2026-11-05T10:00:00Z" }));
    expect(response.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id: "evt-1", kind: "cloudevents", type: "google.cloud.storage.object.v1.finalized", subject: "objects/a.png", data: { bucket: "photos", name: "a.png" }, attributes: { source: "//storage.googleapis.com/projects/_/buckets/photos", specversion: "1.0" } });
    expect(seen[0]!.time.toISOString()).toBe("2026-11-05T10:00:00.000Z");
  });

  test("structured and batch requests run the trigger once per event, bytes stay bytes, and a missing ce-id answers 400", async () => {
    const seen: unknown[] = [];
    const app = await start({ billing: trigger({ source: cloudEvents({ type: "billing.*" }), handle: ({ event }) => void seen.push(event.data) }) });
    const post = (type: string, body: unknown) => app.fetch("/_triggers/billing", { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
    expect((await post("application/cloudevents+json", structured({}))).status).toBe(204);
    expect((await post("application/cloudevents-batch+json", [structured({ id: "b1", data: { n: 1 } }), structured({ id: "b2", data: { n: 2 } })])).status).toBe(204);
    expect(seen).toEqual([{ amount: 10 }, { n: 1 }, { n: 2 }]);
    const bytes = await app.fetch("/_triggers/billing", { method: "POST", headers: { "content-type": "application/octet-stream", "ce-specversion": "1.0", "ce-id": "x", "ce-source": "/b", "ce-type": "billing.raw" }, body: new Uint8Array([1, 2, 3]) });
    expect(bytes.status).toBe(204);
    expect(seen[3]).toEqual(new Uint8Array([1, 2, 3]));
    const missing = await app.fetch("/_triggers/billing", binary({ "ce-id": "" }));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "VALIDATION_ERROR", message: "Invalid CloudEvent: missing id" });
    expect((await post("application/cloudevents+json", { ...structured({}), specversion: undefined })).status).toBe(400);
  });
});

/** A signing key, its public JWK and a function signing RS256 tokens with it. */
async function testIssuer() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as { privateKey: unknown; publicKey: unknown };
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey as never)) as Record<string, unknown>), kid: "key-1", alg: "RS256", use: "sig" };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = async (claims: Record<string, unknown>) => {
    const input = `${encode({ alg: "RS256", kid: "key-1", typ: "JWT" })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey as never, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString("base64url")}`;
  };
  return { jwk, sign };
}

describe("authentication", () => {
  test("a wrong bearer token answers 401 without running the trigger", async () => {
    let runs = 0;
    const app = await start({ hook: trigger({ source: cloudEvents({ auth: { bearer: "s3cret" } }), handle: () => void runs++ }) });
    const wrong = await app.fetch("/_triggers/hook", binary({ authorization: "Bearer nope" }));
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "INVALID_SIGNATURE", message: "Invalid event credentials" });
    expect((await app.fetch("/_triggers/hook", binary({}))).status).toBe(401);
    expect(runs).toBe(0);
    expect((await app.fetch("/_triggers/hook", binary({ authorization: "Bearer s3cret" }))).status).toBe(204);
    expect(runs).toBe(1);
  });

  test("an OIDC token signed by the issuer's key passes, and an expired one, another audience or another email answers 401", async () => {
    const { jwk, sign } = await testIssuer();
    const mock = http.mock();
    try {
      mock.on("GET", "https://accounts.google.com/.well-known/openid-configuration").reply(200, { jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
      mock.on("GET", "https://www.googleapis.com/oauth2/v3/certs").reply(200, { keys: [jwk] });
      let runs = 0;
      const app = await start({ push: trigger({ source: cloudEvents({ auth: { oidc: { audience: "https://svc.example/_triggers/push", email: "pusher@proj.iam.gserviceaccount.com" } } }), handle: () => void runs++ }) });
      const claims = { iss: "https://accounts.google.com", aud: "https://svc.example/_triggers/push", email: "pusher@proj.iam.gserviceaccount.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
      const push = async (token: string) => (await app.fetch("/_triggers/push", binary({ authorization: `Bearer ${token}` }))).status;
      expect(await push(await sign(claims))).toBe(204);
      expect(await push(await sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }))).toBe(401);
      expect(await push(await sign({ ...claims, aud: "https://other" }))).toBe(401);
      expect(await push(await sign({ ...claims, email: "someone@else" }))).toBe(401);
      expect(await push(`${(await sign(claims)).slice(0, -4)}AAAA`)).toBe(401);
      expect(runs).toBe(1);
      // The keys are fetched once and kept.
      expect(mock.calls.filter((call) => call.url.endsWith("/certs"))).toHaveLength(1);
      expect(mock.calls[0]!.service).toBe("triggers/oidc");
    } finally {
      mock.restore();
    }
  });
});

describe("handshake and status codes", () => {
  test("the Event Grid OPTIONS handshake answers 200 with the allowed origin and rate", async () => {
    const app = await start({ grid: trigger({ source: cloudEvents(), handle() {} }) });
    const response = await app.fetch("/_triggers/grid", { method: "OPTIONS", headers: { "WebHook-Request-Origin": "eventgrid.azure.net" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("WebHook-Allowed-Origin")).toBe("eventgrid.azure.net");
    expect(response.headers.get("WebHook-Allowed-Rate")).toBe("*");
  });

  test("a failed event answers 500 with no details; a discarded or unmatched one answers 204", async () => {
    const app = await start({ fails: trigger({ source: cloudEvents({ type: "billing.*" }), handle: () => Promise.reject(new Error("database password is hunter2")) }) });
    const failed = await app.fetch("/_triggers/fails", { method: "POST", headers: { "content-type": "application/cloudevents+json" }, body: JSON.stringify(structured({})) });
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("");
    const unmatched = await app.fetch("/_triggers/fails", { method: "POST", headers: { "content-type": "application/cloudevents+json" }, body: JSON.stringify(structured({ type: "orders.created" })) });
    expect(unmatched.status).toBe(204);
  });
});

describe("security items", () => {
  test("a cookie-less cross-site push is accepted, the route is exempt from CSRF and still rate limited", async () => {
    const app = await start({ hook: trigger({ source: cloudEvents(), handle() {} }) }, { security: { rateLimit: { limit: "2/min" } } });
    const crossSite = () => app.fetch("/_triggers/hook", binary({ origin: "https://evil.example" }));
    expect((await crossSite()).status).toBe(204);
    expect((await crossSite()).status).toBe(204);
    expect((await crossSite()).status).toBe(429);
    const req = { method: "POST", route: "/_triggers/hook", raw: new Request("http://localhost/_triggers/hook") } as unknown as ServiceRequest;
    expect((securityFeature.optionsFor(req).csrf as { enabled: boolean }).enabled).toBe(false);
  });
});
