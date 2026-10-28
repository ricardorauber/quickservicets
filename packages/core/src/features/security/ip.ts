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

/** The runtime parts of the `ip` item: a source's lists, the temporary blocks and automatic blocking. */
export interface IpRuntime {
  /** The lists of `ip.source`, whose check the last load swapped in. */
  dynamic?: { readonly check: Check | undefined };
  /** The temporary blocks, checked first while any is stored. */
  blocks?: { readonly size: number; matches(address: string): boolean };
  /** Automatic blocking: counts the listed answers of addresses no allow list covers. */
  auto?: { statuses: ReadonlySet<number>; count(address: string): void; exempt(address: string): boolean };
}

/**
 * The step of the `ip` item, or undefined when there is nothing to check (empty global lists, no route tags and no
 * runtime parts): refuses with 403 `Address not allowed` an address with an active temporary block or that the global
 * lists refuse (unless the path is exempted from `ip`), or that its route's lists refuse; with automatic blocking, it
 * counts the listed answers on the way out.
 */
export function ipStep(lists: IpLists, ipOf: (request: Request) => string, tagged: readonly SecurityRoute[], compile: CompileList = cidrMatcher, runtime: IpRuntime = {}): SecurityStep | undefined {
  const { dynamic, blocks, auto } = runtime;
  // With a source, the global check is the one its last load swapped in; otherwise it is compiled once here.
  const fixed = dynamic ? undefined : compileLists(lists, compile);
  const byRoute = tagged.some((route) => route.tags.ipAllow || route.tags.ipDeny);
  if (!fixed && !dynamic && !byRoute && !blocks) return undefined;
  const step: SecurityStep = {
    name: "ip",
    before(state: SecurityState) {
      // Blocks apply whatever the allow lists say; with none stored, this is the only work they add.
      if (blocks && blocks.size > 0 && !(state.exempt & EXEMPT.ip) && blocks.matches(ipOf(state.ctx.request))) {
        (state.values ??= {}).ipBlocked = true;
        throw state.refuse("ip", refused(), { reason: "blocked" });
      }
      const global = dynamic ? dynamic.check : fixed;
      const own = byRoute && state.route ? routeCheck(state.route, compile) : undefined;
      const checksGlobal = global !== undefined && !(state.exempt & EXEMPT.ip);
      if (!checksGlobal && !own) return;
      const ip = ipOf(state.ctx.request);
      if (checksGlobal && !global(ip)) throw state.refuse("ip", refused());
      if (own && !own(ip)) throw state.refuse("ip", refused());
    },
  };
  if (auto) {
    step.after = (response, state) => {
      // The answers of blocks never extend them, and exempted paths never count.
      if (!auto.statuses.has(response.status) || state.values?.ipBlocked || state.exempt & EXEMPT.ip) return response;
      const ip = ipOf(state.ctx.request);
      if (!auto.exempt(ip)) auto.count(ip);
      return response;
    };
  }
  return step;
}
