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

/** `GET /openapi.json` and `GET /docs`; they run no hooks. */
export function docsRoutes(document: { info?: { title?: string } }): Route[] {
  const json = JSON.stringify(document);
  const html = docsPage(document.info?.title ?? "QuickService.ts API");
  return [
    {
      method: "GET",
      path: OPENAPI_PATH,
      handler: () => new Response(json, { headers: { "content-type": "application/json" } }),
    },
    {
      method: "GET",
      path: DOCS_PATH,
      handler: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
  ];
}
