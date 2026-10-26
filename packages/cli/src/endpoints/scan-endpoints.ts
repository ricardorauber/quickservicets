import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BuildError } from "../errors.ts";

export const ENDPOINT_METHODS = ["get", "post", "put", "patch", "delete", "options"] as const;
export type EndpointMethod = Uppercase<(typeof ENDPOINT_METHODS)[number]>;

export interface EndpointRoute {
  method: EndpointMethod;
  /** Route path with named dynamic segments, e.g. `/organizations/[orgId]`. */
  path: string;
  /** Path with dynamic segments normalized to `:`, used to compare routes, e.g. `/organizations/:`. */
  pattern: string;
  params: string[];
  /** File path relative to the project root, or `@quickservice/core/features/...` for a native's file. */
  file: string;
  /** Absolute path of the file (default: the file under the project root). */
  source?: string;
  /** The key of the feature whose folder holds the file. */
  feature?: string;
  /** `sse` for an `sse.ts` file: a `GET` route streaming Server-Sent Events. */
  kind?: "sse";
}

/** The file name of a Server-Sent Events endpoint, served as `GET`. */
export const SSE_FILE = "sse.ts";

const PARAM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const STATIC_SEGMENT = /^[a-z0-9.-]+$/;

interface Segment {
  static?: string;
  param?: string;
}

function parseSegment(folder: string, relativeFolder: string): Segment {
  if (/^\[\[?\.\.\./.test(folder)) {
    throw new BuildError(`${relativeFolder}: catch-all segments like ${folder} are not supported`);
  }
  const dynamic = /^\[(.*)\]$/.exec(folder);
  if (dynamic) {
    const name = dynamic[1]!;
    if (!PARAM_NAME.test(name)) {
      throw new BuildError(`${relativeFolder}: parameter name "${name}" must match ^[a-zA-Z_][a-zA-Z0-9_]*$`);
    }
    return { param: name };
  }
  if (!STATIC_SEGMENT.test(folder)) {
    throw new BuildError(`${relativeFolder}: path segments may only contain a-z, 0-9, "-" and "."`);
  }
  return { static: folder };
}

export function scanEndpoints(projectRoot: string): EndpointRoute[] {
  return scanEndpointFolder(join(projectRoot, "endpoints"), (file) => relative(projectRoot, file)).map(({ source: _source, ...route }) => route);
}

/** Scans one endpoints folder; `nameOf` gives the name the build shows for each file. */
export function scanEndpointFolder(root: string, nameOf: (file: string) => string): EndpointRoute[] {
  const routes: EndpointRoute[] = [];

  const walk = (dir: string, segments: Segment[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    const dynamicFolders: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      const relativePath = nameOf(full);
      if (statSync(full).isDirectory()) {
        const segment = parseSegment(entry, relativePath);
        if (segment.param !== undefined) dynamicFolders.push(relativePath);
        if (dynamicFolders.length > 1) {
          throw new BuildError(`${dynamicFolders.join(" and ")}: sibling dynamic segments must use the same name`);
        }
        walk(full, [...segments, segment]);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const sse = entry === SSE_FILE;
      const method = sse ? "get" : entry.slice(0, -3);
      if (!sse && !(ENDPOINT_METHODS as readonly string[]).includes(method)) {
        throw new BuildError(`${relativePath}: endpoint files must be named ${ENDPOINT_METHODS.join(", ")} or sse (with .ts)`);
      }
      if (sse && entries.includes("get.ts")) {
        throw new BuildError(`${nameOf(join(dir, "get.ts"))} and ${relativePath}: a folder has one GET route; keep one of them`);
      }
      const path = `/${segments.map((segment) => segment.static ?? `[${segment.param}]`).join("/")}`;
      const pattern = `/${segments.map((segment) => segment.static ?? ":").join("/")}`;
      routes.push({
        method: method.toUpperCase() as EndpointMethod,
        path,
        pattern,
        params: segments.flatMap((segment) => (segment.param === undefined ? [] : [segment.param])),
        file: relativePath,
        source: full,
        ...(sse ? { kind: "sse" as const } : {}),
      });
    }
  };

  walk(root, []);
  return routes;
}
