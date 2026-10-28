import { cidrMatcher, HttpError } from "../public.ts";
import { EXEMPT } from "./exempt.ts";
import type { SecurityState, SecurityStep } from "./pipeline.ts";
import type { SecurityRoute } from "./routes.ts";

/** The `ip` item's lists: addresses, CIDR blocks or the names `loopback`, `private` and `linklocal`. */
export interface IpLists {
  allow: readonly string[];
  deny: readonly string[];
}

/** Compiles a list into a matcher; tests pass a spying one. */
export type CompileList = (entries: readonly string[]) => (address: string) => boolean;

/** A compiled pair of lists: whether an address passes them. */
type Check = (address: string) => boolean;

/**
 * Compiles a pair of lists: an address is refused when it matches `deny`, or when `allow` is not empty and it matches
 * none of `allow` (`unknown` included); a deny match wins.
 */
export function compileLists(lists: IpLists, compile: CompileList = cidrMatcher): Check | undefined {
  if (lists.allow.length === 0 && lists.deny.length === 0) return undefined;
  const allowed = lists.allow.length > 0 ? compile(lists.allow) : undefined;
  const denied = lists.deny.length > 0 ? compile(lists.deny) : undefined;
  return (address) => !(denied?.(address) ?? false) && (allowed === undefined || allowed(address));
}

const refused = () => new HttpError(403, "Address not allowed");

/** The lists a route's `@ipAllow` and `@ipDeny` tags give it, compiled once per route. */
function routeCheck(route: SecurityRoute, compile: CompileList): Check | undefined {
  if (!route.cache.has("ip")) {
    const allow = route.tags.ipAllow?.on ? ((route.tags.ipAllow.options.allow as string[] | undefined) ?? []) : [];
    const deny = route.tags.ipDeny?.on ? ((route.tags.ipDeny.options.deny as string[] | undefined) ?? []) : [];
    route.cache.set("ip", compileLists({ allow, deny }, compile));
  }
  return route.cache.get("ip") as Check | undefined;
}

/**
 * The step of the `ip` item, or undefined when there is nothing to check (empty global lists and no route tags):
 * refuses with 403 `Address not allowed` an address the global lists refuse (unless the path is exempted from `ip`)
 * or that its route's lists refuse.
 */
export function ipStep(lists: IpLists, ipOf: (request: Request) => string, tagged: readonly SecurityRoute[], compile: CompileList = cidrMatcher, dynamic?: { readonly check: Check | undefined }): SecurityStep | undefined {
  // With a source, the global check is the one its last load swapped in; otherwise it is compiled once here.
  const fixed = dynamic ? undefined : compileLists(lists, compile);
  const byRoute = tagged.some((route) => route.tags.ipAllow || route.tags.ipDeny);
  if (!fixed && !dynamic && !byRoute) return undefined;
  return {
    name: "ip",
    before(state: SecurityState) {
      const global = dynamic ? dynamic.check : fixed;
      const own = byRoute && state.route ? routeCheck(state.route, compile) : undefined;
      const checksGlobal = global !== undefined && !(state.exempt & EXEMPT.ip);
      if (!checksGlobal && !own) return;
      const ip = ipOf(state.ctx.request);
      if (checksGlobal && !global(ip)) throw state.refuse("ip", refused());
      if (own && !own(ip)) throw state.refuse("ip", refused());
    },
  };
}
