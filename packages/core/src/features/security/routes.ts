import { Router, type ParsedTags, type TaggedRoute } from "../public.ts";

/** A route carrying at least one security tag, as the request stage finds it before routing. */
export interface SecurityRoute {
  method: string;
  /** The route path, with `[param]` segments. */
  path: string;
  /** The security tags that apply to the route, by name. */
  tags: ParsedTags;
  /** Values the items compute once per route, like its resolved options, by item. */
  cache: Map<string, unknown>;
}

/** How many route indexes were built in this process; tests read it to check none is built without tags. */
export const routeIndexStats = { builds: 0 };

/** Finds the tagged route of a request by method and path, before the core's routing. */
export interface RouteIndex {
  find(method: string, path: string): SecurityRoute | undefined;
  /** The routes carrying a security tag. */
  readonly routes: readonly SecurityRoute[];
}

/**
 * The index of the app's routes for finding those that carry one of `tagNames`, built with the core's `Router`;
 * undefined when no route carries one, so requests do no lookup.
 */
export function buildRouteIndex(routes: readonly TaggedRoute[], tagNames: readonly string[]): RouteIndex | undefined {
  const entries: { method: string; path: string; value: SecurityRoute | undefined }[] = [];
  let tagged = false;
  for (const route of routes) {
    const tags: ParsedTags = {};
    for (const name of tagNames) if (route.tags?.[name]) tags[name] = route.tags[name]!;
    const found = Object.keys(tags).length > 0;
    tagged ||= found;
    // Untagged routes stay in the index, so a request matches the same route as the core's routing.
    entries.push({ method: route.method, path: route.path, value: found ? { method: route.method, path: route.path, tags, cache: new Map() } : undefined });
  }
  if (!tagged) return undefined;
  routeIndexStats.builds++;
  const router = new Router(entries);
  return {
    routes: entries.flatMap((entry) => (entry.value ? [entry.value] : [])),
    find(method, path) {
      let match: ReturnType<typeof router.match>;
      try {
        match = router.match(method, path);
      } catch {
        // A path the router refuses (an invalid escape) is answered by the core's routing.
        return undefined;
      }
      return match.kind === "found" ? match.route.value : undefined;
    },
  };
}
