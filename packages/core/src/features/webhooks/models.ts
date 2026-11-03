import type { EntityModel, FieldModel } from "../public.ts";

const sensitive = { sensitive: { on: true, options: {} } };

/** The fields of `WebhookSubscription` the native reads and writes, with their types. */
export const SUBSCRIPTION_FIELDS: readonly FieldModel[] = [
  { name: "url", type: "string", optional: false, storage: "column" },
  { name: "events", type: "array", items: { type: "string" }, optional: false, storage: "json" },
  { name: "description", type: "string", optional: true, storage: "column" },
  { name: "secret", type: "string", optional: false, hidden: true, tags: sensitive, storage: "column" },
  { name: "previousSecret", type: "string", optional: true, hidden: true, tags: sensitive, storage: "column" },
  { name: "previousSecretExpiresAt", type: "date", optional: true, storage: "column" },
  { name: "enabled", type: "boolean", optional: false, default: true, storage: "column" },
  { name: "disabledReason", type: "string", optional: true, storage: "column" },
  { name: "failingSince", type: "date", optional: true, storage: "column" },
  { name: "headers", type: "json", optional: true, storage: "json" },
  { name: "tenant", type: "string", optional: true, storage: "column" },
  { name: "createdBy", type: "string", optional: true, storage: "column" },
] as FieldModel[];

/** The model of a native entity: no routes, its own collection, shared by every tenant (each record names its tenant). */
function nativeModel(key: string, collection: string, fields: readonly FieldModel[], extra: Partial<EntityModel>): EntityModel {
  const include = ["id", "createdAt", "updatedAt", ...fields.map((field) => field.name)];
  const hidden = fields.filter((field) => field.hidden).map((field) => field.name);
  return {
    key,
    entityName: key,
    schema: null,
    name: collection,
    repoKey: collection.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    tableName: collection.replace(/-/g, "_"),
    fields: fields.map((field) => ({ ...field })),
    hooks: [],
    overrideHooks: "inherit",
    internal: true,
    exposure: { list: { include, exclude: hidden }, read: { include, exclude: hidden } },
    tenancy: "shared",
    ...extra,
  };
}

/** The internal entity of webhook subscriptions: no generated routes, a writable repository. */
export function webhookSubscriptionEntity(): EntityModel {
  return nativeModel("WebhookSubscription", "webhook-subscriptions", SUBSCRIPTION_FIELDS, { indexes: [{ fields: ["tenant", "enabled"] }] });
}
