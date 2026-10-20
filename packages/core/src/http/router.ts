import { HttpError } from "../errors.ts";

export interface RoutePattern<T> {
  method: string;
  /** Route path with dynamic segments in brackets, e.g. `/users/[id]`. */
  path: string;
  value: T;
}

interface CompiledRoute<T> {
  method: string;
  segments: { static?: string; param?: string }[];
  route: RoutePattern<T>;
}

export type RouteMatch<T> =
  | { kind: "found"; route: RoutePattern<T>; params: Record<string, string> }
  | { kind: "methodNotAllowed"; allow: string[] }
  | { kind: "notFound" };

/** Normalizes a route path to a pattern where every dynamic segment is `:`, e.g. `/users/[id]` → `/users/:`. */
export function patternOf(path: string): string {
  return `/${splitPath(path).map((segment) => (/^\[.+\]$/.test(segment) ? ":" : segment)).join("/")}`;
}

export function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/** Routes of one shape bucket, by method and all together, in declaration order. */
interface Bucket<T> {
  byMethod: Map<string, CompiledRoute<T>[]>;
  all: CompiledRoute<T>[];
}

/** The routes with one segment count: by their first static segment, and those whose first segment is dynamic (or absent). */
interface Shape<T> {
  byFirst: Map<string, Bucket<T>>;
  rest: Bucket<T>;
}

const emptyBucket = (): Bucket<unknown> => ({ byMethod: new Map(), all: [] });

/**
 * Matches request paths to routes, preferring static segments over dynamic ones at each level. Routes are indexed by
 * segment count, first static segment and method, so a request is compared only with routes that can match it.
 */
export class Router<T> {
  private readonly shapes = new Map<number, Shape<T>>();

  constructor(routes: RoutePattern<T>[]) {
    for (const route of routes) {
      const compiled: CompiledRoute<T> = {
        method: route.method.toUpperCase(),
        route,
        segments: splitPath(route.path).map((segment) => {
          const dynamic = /^\[(.+)\]$/.exec(segment);
          return dynamic ? { param: dynamic[1]! } : { static: segment };
        }),
      };
      let shape = this.shapes.get(compiled.segments.length);
      if (!shape) this.shapes.set(compiled.segments.length, (shape = { byFirst: new Map(), rest: emptyBucket() as Bucket<T> }));
      const first = compiled.segments[0]?.static;
      let bucket = shape.rest;
      if (first !== undefined) {
        bucket = shape.byFirst.get(first) ?? (emptyBucket() as Bucket<T>);
        shape.byFirst.set(first, bucket);
      }
      bucket.all.push(compiled);
      const sameMethod = bucket.byMethod.get(compiled.method);
      if (sameMethod) sameMethod.push(compiled);
      else bucket.byMethod.set(compiled.method, [compiled]);
    }
  }

  match(method: string, path: string): RouteMatch<T> {
    const parts = splitPath(path);
    const shape = this.shapes.get(parts.length);
    if (!shape) return { kind: "notFound" };
    const upper = method.toUpperCase();
    const staticFirst = parts.length > 0 ? shape.byFirst.get(parts[0]!) : undefined;
    // A route whose first segment is static beats every route whose first segment is dynamic.
    const best = bestOf(staticFirst?.byMethod.get(upper), parts) ?? bestOf(shape.rest.byMethod.get(upper), parts);
    if (!best) {
      const allow = new Set<string>();
      for (const route of staticFirst?.all ?? []) if (matches(route, parts)) allow.add(route.method);
      for (const route of shape.rest.all) if (matches(route, parts)) allow.add(route.method);
      return allow.size === 0 ? { kind: "notFound" } : { kind: "methodNotAllowed", allow: [...allow].sort() };
    }
    const params: Record<string, string> = {};
    best.segments.forEach((segment, index) => {
      if (segment.param !== undefined) params[segment.param] = decodeSegment(parts[index]!);
    });
    return { kind: "found", route: best.route, params };
  }
}

function matches<T>(route: CompiledRoute<T>, parts: string[]): boolean {
  for (let index = 0; index < parts.length; index++) {
    const segment = route.segments[index]!;
    if (segment.param === undefined && segment.static !== parts[index]) return false;
  }
  return true;
}

/** The most specific matching route; between equally specific ones, the first declared. */
function bestOf<T>(routes: CompiledRoute<T>[] | undefined, parts: string[]): CompiledRoute<T> | undefined {
  let best: CompiledRoute<T> | undefined;
  for (const route of routes ?? []) {
    if (matches(route, parts) && (best === undefined || moreSpecific(route, best))) best = route;
  }
  return best;
}

function moreSpecific<T>(candidate: CompiledRoute<T>, current: CompiledRoute<T>): boolean {
  for (let index = 0; index < candidate.segments.length; index++) {
    const a = candidate.segments[index]!.static !== undefined;
    const b = current.segments[index]!.static !== undefined;
    if (a !== b) return a;
  }
  return false;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "Invalid path");
  }
}
