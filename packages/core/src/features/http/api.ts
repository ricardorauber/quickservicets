import type { FeatureHook } from "../public.ts";
import type { HttpModifier, HttpRequest, HttpResponse } from "./client.ts";
import type { HttpClientError } from "./errors.ts";
import type { ServiceOptionsInput } from "./options.ts";

/** The feature API of `http`, reached with `ctx.feature("http")` from a feature that lists `http` in `after` or `requires`. */
export interface HttpApi {
  /**
   * Registers a named service during setup, under `<feature key>/<name>` (or the feature key itself when `name` is
   * it), with the options of `http.services`; its host is trusted by SSRF protection for calls through it.
   */
  addService(name: string, options: ServiceOptionsInput): void;
  /**
   * Registers a named modifier during setup, which services list in `modifiers`; a name registered twice fails
   * startup naming both owners.
   */
  modifier(name: string, modifier: HttpModifier): void;
  /** Appends a `beforeRequest` hook after the config's: it may return a changed request, and a throw cancels the call. */
  beforeRequest(fn: FeatureHook<HttpRequest, undefined>): void;
  /** Appends an `afterResponse` hook, run after every attempt that got a response. */
  afterResponse(fn: FeatureHook<{ request: HttpRequest; response: HttpResponse; durationMs: number }, undefined>): void;
  /** Appends an `onError` hook, run after every attempt that failed. */
  onError(fn: FeatureHook<{ request: HttpRequest; error: HttpClientError }, undefined>): void;
}
