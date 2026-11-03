import type { EntityModel } from "../public.ts";
import { WEBHOOK_OPERATIONS, type WebhookOperation } from "./options.ts";

const SEGMENT = /^[a-z][A-Za-z0-9-]*$/;

const lowerFirst = (name: string) => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/**
 * Why a text is not an event pattern (an exact type, `*` segments, the lone `*`, or `<entity>.written`), or undefined
 * when it is one.
 */
export function patternProblem(pattern: unknown): string | undefined {
  if (typeof pattern !== "string") return "expected an event pattern text";
  if (pattern === "*") return undefined;
  const segments = pattern.split(".");
  if (segments.length < 2 || !segments.every((segment) => segment === "*" || SEGMENT.test(segment))) {
    return `${pattern} is not an event pattern (like order.created, order.* or *.created)`;
  }
  return undefined;
}

/** A pattern as segment lists, `<entity>.written` expanded into its three write operations; `*` alone is null. */
function expand(pattern: string): string[][] | null {
  if (pattern === "*") return null;
  const segments = pattern.split(".");
  if (segments.at(-1) === "written") return WEBHOOK_OPERATIONS.map((operation) => [...segments.slice(0, -1), operation]);
  return [segments];
}

/** Whether a pattern matches an event type, with the semantics of the events native. */
export function patternMatchesType(pattern: string, type: string): boolean {
  const forms = expand(pattern);
  if (forms === null) return true;
  const parts = type.split(".");
  return forms.some((segments) => segments.length === parts.length && segments.every((segment, index) => segment === "*" || segment === parts[index]));
}

/** Whether two patterns match at least one common event type. */
export function patternsOverlap(a: string, b: string): boolean {
  const left = expand(a);
  const right = expand(b);
  if (left === null || right === null) return true;
  return left.some((x) => right.some((y) => x.length === y.length && x.every((segment, index) => segment === "*" || y[index] === "*" || segment === y[index])));
}

/** How one entity takes part in webhooks, from its `@webhooks` tag. */
export interface EntityDelivery {
  entity: EntityModel;
  /** The lower camel case prefix of its event types, like `order`. */
  prefix: string;
  /** `on` when tagged, `off` with `@webhooks off`, `untagged` otherwise. */
  tag: "on" | "off" | "untagged";
  /** The operations a tagged entity delivers. */
  operations: readonly WebhookOperation[];
  /** With `fields`, the only fields (and `id`) its records carry. */
  fields?: readonly string[];
}

/** The settings of every entity whose events may be delivered, from the tag options the build parsed. */
export function entityDeliveries(models: readonly EntityModel[], defaults: { events: readonly WebhookOperation[] }): EntityDelivery[] {
  return models
    .filter((entity) => !entity.system && !entity.link && entity.feature !== "webhooks")
    .map((entity) => {
      const tag = entity.tags?.webhooks;
      const options = (tag?.options ?? {}) as { events?: readonly WebhookOperation[]; fields?: readonly string[] };
      const operations = options.events ?? defaults.events;
      return {
        entity,
        prefix: lowerFirst(entity.entityName),
        tag: tag === undefined ? "untagged" : tag.on ? "on" : "off",
        operations,
        ...(options.fields ? { fields: options.fields } : {}),
      } as EntityDelivery;
    });
}

/**
 * Which events subscriptions may receive: the write events of tagged entities, and every event the `events` option
 * matches, except the native's own `webhook.*` events and the events of entities tagged `@webhooks off`.
 */
export class DeliverableEvents {
  readonly #patterns: readonly string[];
  readonly #entities: readonly EntityDelivery[];
  readonly #byPrefix: Map<string, EntityDelivery>;

  constructor(patterns: readonly string[], entities: readonly EntityDelivery[]) {
    this.#patterns = patterns;
    this.#entities = entities;
    this.#byPrefix = new Map(entities.map((entry) => [entry.prefix, entry]));
  }

  /** The option's patterns. */
  get patterns(): readonly string[] {
    return this.#patterns;
  }

  /** The entities that take part in webhooks, tagged or untagged. */
  get entities(): readonly EntityDelivery[] {
    return this.#entities;
  }

  /** The write event types of entities, deliverable or not, and the entity each belongs to. */
  #writeTypes(): { type: string; entry: EntityDelivery }[] {
    return this.#entities.flatMap((entry) => WEBHOOK_OPERATIONS.map((operation) => ({ type: `${entry.prefix}.${operation}`, entry })));
  }

  /** The entity of a write event type, when the type is one. */
  entityOf(type: string): EntityDelivery | undefined {
    const parts = type.split(".");
    if (parts.length !== 2 || !(WEBHOOK_OPERATIONS as readonly string[]).includes(parts[1]!)) return undefined;
    return this.#byPrefix.get(parts[0]!);
  }

  /** Whether an event of this type may be delivered. */
  isDeliverable(type: string): boolean {
    if (type === "webhook" || type.startsWith("webhook.")) return false;
    const entry = this.entityOf(type);
    if (entry?.tag === "off") return false;
    if (entry?.tag === "on" && entry.operations.includes(type.split(".")[1] as WebhookOperation)) return true;
    return this.#patterns.some((pattern) => patternMatchesType(pattern, type));
  }

  /** Whether a subscription pattern matches at least one deliverable event. */
  matchesAny(pattern: string): boolean {
    if (this.#writeTypes().some(({ type }) => this.isDeliverable(type) && patternMatchesType(pattern, type))) return true;
    // Custom events: any option pattern sharing a type with the subscription's, other than webhook events and write events.
    return this.#patterns.some((option) => customOverlap(pattern, option));
  }

  /** The patterns the listener observes: the option's, and the write events of each tagged entity. */
  listenedPatterns(): string[] {
    const tagged = this.#entities.filter((entry) => entry.tag === "on").flatMap((entry) => entry.operations.map((operation) => `${entry.prefix}.${operation}`));
    return [...new Set([...this.#patterns, ...tagged])];
  }
}

/** The segment lists two patterns have in common (`*` where both are wildcards); the lone `*` takes the other's forms. */
function intersections(a: string, b: string): string[][] {
  const left = expand(a);
  const right = expand(b);
  if (left === null && right === null) return [["*", "*"]];
  if (left === null) return right!;
  if (right === null) return left;
  return left.flatMap((x) =>
    right.filter((y) => y.length === x.length && x.every((segment, index) => segment === "*" || y[index] === "*" || segment === y[index])).map((y) => x.map((segment, index) => (segment === "*" ? y[index]! : segment))),
  );
}

/** Whether two patterns share a type that can be a custom event: not a webhook event, not ending like a write event. */
function customOverlap(a: string, b: string): boolean {
  return intersections(a, b).some((segments) => segments[0] !== "webhook" && !([...WEBHOOK_OPERATIONS, "written"] as readonly string[]).includes(segments.at(-1)!));
}

/** The event types of the native itself, which are never deliverable. */
export const NATIVE_EVENT_PREFIX = "webhook.";
