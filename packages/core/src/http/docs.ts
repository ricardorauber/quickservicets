import type { Route } from "./server.ts";

/** The exact Scalar version the docs page loads from jsDelivr. */
export const SCALAR_VERSION = "1.72.3";
export const SCALAR_URL = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}`;
/** Paths the API docs reserve. */
export const DOCS_PATH = "/docs";
export const OPENAPI_PATH = "/openapi.json";

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** The HTML page that renders the OpenAPI document with Scalar. */
export function docsPage(title: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} API</title>
  </head>
  <body>
    <script id="api-reference" data-url="${OPENAPI_PATH}"></script>
    <script src="${SCALAR_URL}"></script>
  </body>
</html>
`;
}

/** An OpenAPI document, or a function reading it on first use. */
export type OpenApiInput = { info?: { title?: string } } | (() => { info?: { title?: string } } | Promise<{ info?: { title?: string } }>);

/**
 * `GET /openapi.json` and `GET /docs`; they run no hooks. The document is read, and the page built, on the first
 * request to either route, so starting the service never reads it.
 */
export function docsRoutes(document: OpenApiInput): Route[] {
  let built: Promise<{ json: string; html: string }> | undefined;
  const contents = () =>
    (built ??= Promise.resolve(typeof document === "function" ? document() : document).then(
      (value) => ({ json: JSON.stringify(value), html: docsPage(value.info?.title ?? "QuickService.ts API") }),
      (error: unknown) => {
        built = undefined;
        throw error;
      },
    ));
  return [
    {
      method: "GET",
      path: OPENAPI_PATH,
      handler: async () => new Response((await contents()).json, { headers: { "content-type": "application/json" } }),
    },
    {
      method: "GET",
      path: DOCS_PATH,
      handler: async () => new Response((await contents()).html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
  ];
}
