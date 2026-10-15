import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BuildError } from "../errors.ts";

export const ENDPOINT_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type EndpointMethod = Uppercase<(typeof ENDPOINT_METHODS)[number]>;

export interface EndpointRoute {
  method: EndpointMethod;
  /** Route path with named dynamic segments, e.g. `/organizations/[orgId]`. */
  path: string;
  /** Path with dynamic segments normalized to `:`, used to compare routes, e.g. `/organizations/:`. */
  pattern: string;
  params: string[];
  /** File path relative to the project root. */
  file: string;
}

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
  const root = join(projectRoot, "endpoints");
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
      const relativePath = relative(projectRoot, full);
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
      const method = entry.slice(0, -3);
      if (!(ENDPOINT_METHODS as readonly string[]).includes(method)) {
        throw new BuildError(`${relativePath}: endpoint files must be named ${ENDPOINT_METHODS.join(", ")} (with .ts)`);
      }
      const path = `/${segments.map((segment) => segment.static ?? `[${segment.param}]`).join("/")}`;
      const pattern = `/${segments.map((segment) => segment.static ?? ":").join("/")}`;
      routes.push({
        method: method.toUpperCase() as EndpointMethod,
        path,
        pattern,
        params: segments.flatMap((segment) => (segment.param === undefined ? [] : [segment.param])),
        file: relativePath,
      });
    }
  };

  walk(root, []);
  return routes;
}
