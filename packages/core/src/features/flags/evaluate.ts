import { createHash } from "node:crypto";

/** A flag rule: `true` or `false` for everyone, or who it is on for. */
export interface FlagRule {
  enabled: boolean;
  users?: readonly string[];
  tenants?: readonly string[];
  percentage?: number;
  description?: string;
}

/** Why a flag has its value for someone. */
export type FlagReason = "disabled" | "user" | "tenant" | "percentage" | "default" | "function" | "unknown" | "provider";

/** The value of a flag for someone, with why. */
export interface FlagResult {
  on: boolean;
  reason: FlagReason;
}

/** Who a flag is evaluated for: the ids of a user and a tenant, when there are any. */
export interface FlagSubject {
  userId?: string;
  tenantId?: string;
}

/** The pattern of flag names. */
export const FLAG_NAME = /^[a-z][a-z0-9_-]*$/;

/** The message of a flag name that does not match the pattern. */
export const FLAG_NAME_MESSAGE = 'a flag name starts with a lowercase letter and uses lowercase letters, digits, "_" and "-"';

/**
 * The percentage bucket of a subject for a flag: the first four bytes of SHA-256 of `<flag>:<user id>` (or the tenant
 * id without a user), as an unsigned integer, modulo 100; the same in every process. Undefined without either id.
 */
export function bucketOf(flag: string, subject: FlagSubject): number | undefined {
  const id = subject.userId ?? subject.tenantId;
  if (id === undefined) return undefined;
  return createHash("sha256").update(`${flag}:${id}`).digest().readUInt32BE(0) % 100;
}

/**
 * Evaluates a rule, in order: disabled → off; the user listed → on; the tenant listed → on; inside the percentage →
 * on; a rule listing nobody → on for everyone; otherwise off.
 */
export function evaluateRule(name: string, rule: FlagRule, subject: FlagSubject): FlagResult {
  if (!rule.enabled) return { on: false, reason: "disabled" };
  if (subject.userId !== undefined && rule.users?.includes(subject.userId)) return { on: true, reason: "user" };
  if (subject.tenantId !== undefined && rule.tenants?.includes(subject.tenantId)) return { on: true, reason: "tenant" };
  if (rule.percentage !== undefined) {
    const bucket = bucketOf(name, subject);
    if (bucket !== undefined && bucket < rule.percentage) return { on: true, reason: "percentage" };
  }
  const targeted = rule.users !== undefined || rule.tenants !== undefined || rule.percentage !== undefined;
  return { on: !targeted, reason: "default" };
}

/** The id of a request's user or tenant, as a text, when it has one. */
export const idOf = (value: unknown): string | undefined => {
  const id = (value as { id?: unknown } | undefined)?.id;
  return id === undefined || id === null ? undefined : String(id);
};
