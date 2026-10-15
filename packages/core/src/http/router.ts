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

/** Matches request paths to routes, preferring static segments over dynamic ones at each level. */
export class Router<T> {
  private readonly routes: CompiledRoute<T>[];

  constructor(routes: RoutePattern<T>[]) {
    this.routes = routes.map((route) => ({
      method: route.method.toUpperCase(),
      route,
      segments: splitPath(route.path).map((segment) => {
        const dynamic = /^\[(.+)\]$/.exec(segment);
        return dynamic ? { param: dynamic[1]! } : { static: segment };
      }),
    }));
  }

  match(method: string, path: string): RouteMatch<T> {
    const parts = splitPath(path);
    const candidates = this.routes.filter(
      (route) =>
        route.segments.length === parts.length &&
        route.segments.every((segment, index) => segment.param !== undefined || segment.static === parts[index]),
    );
    if (candidates.length === 0) return { kind: "notFound" };

    const sameMethod = candidates.filter((route) => route.method === method.toUpperCase());
    if (sameMethod.length === 0) {
      return { kind: "methodNotAllowed", allow: [...new Set(candidates.map((route) => route.method))].sort() };
    }

    const best = sameMethod.reduce((winner, route) => (moreSpecific(route, winner) ? route : winner));
    const params: Record<string, string> = {};
    best.segments.forEach((segment, index) => {
      if (segment.param !== undefined) params[segment.param] = decodeSegment(parts[index]!);
    });
    return { kind: "found", route: best.route, params };
  }
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
