import type { WebhooksApi } from "./api.ts";
import type { WebhookSubscriptions } from "./subscriptions.ts";
import { sharedState } from "./state.ts";

const DISABLED = "webhooks is not enabled; add webhooks: {} to quickservicets.config.ts";

/** The running native's API, set by its setup and cleared when the service stops. */
export const running = sharedState("running", () => ({ current: undefined as WebhooksApi | undefined, deliveries: undefined as RunningDeliveries | undefined }));

/** What the native's queue consumers call. */
export interface RunningDeliveries {
  /** Runs one attempt of a delivery. */
  deliver(id: string, context: { signal: AbortSignal }): Promise<void>;
}

/** The running native's delivery code, for its queue consumers. */
export function runningDeliveries(): RunningDeliveries {
  if (!running.deliveries) throw new Error(DISABLED);
  return running.deliveries;
}


/** The running native's API, or a throw naming how to enable it. */
export function runningWebhooks(): WebhooksApi {
  if (!running.current) throw new Error(DISABLED);
  return running.current;
}

const call = <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return fn();
  } catch (error) {
    return Promise.reject(error);
  }
};

const subscriptions: WebhookSubscriptions = {
  create: (input) => call(() => runningWebhooks().subscriptions.create(input)),
  list: (options) => call(() => runningWebhooks().subscriptions.list(options)),
  get: (id) => call(() => runningWebhooks().subscriptions.get(id)),
  update: (id, changes) => call(() => runningWebhooks().subscriptions.update(id, changes)),
  delete: (id) => call(() => runningWebhooks().subscriptions.delete(id)),
  rotateSecret: (id) => call(() => runningWebhooks().subscriptions.rotateSecret(id)),
  ping: (id) => call(() => runningWebhooks().subscriptions.ping(id)),
};

/** The webhooks of the running service from any code: `webhooks.subscriptions.create(...)` and the rest. */
export const webhooks: WebhooksApi = { subscriptions };
