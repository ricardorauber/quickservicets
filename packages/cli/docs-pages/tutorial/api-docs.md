# API docs at /docs

> Browse the generated OpenAPI document with Scalar, and see how the custom endpoint is documented.

You didn't write any API docs, but the service already has them. Every build writes an OpenAPI 3.1 document for all the generated routes and custom endpoints, and the server serves it with a reference page.

## Two routes

With the server running (`bun run dev`), open these:

- **`/docs`**: an interactive API reference rendered by [Scalar](https://scalar.com). Browse every route, see its parameters and schemas, and send requests from the page.
- **`/openapi.json`**: the raw OpenAPI document, for clients, code generators and other tools.

`/docs` is a small HTML page that loads Scalar from jsDelivr and points it at `/openapi.json`:

```bash
curl localhost:3000/docs
```

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>organizations API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.3"></script>
  </body>
</html>
```

The title comes from the `name` in `package.json` (`organizations` in the example), and the document's version from its `version` (`0.0.0` when there is none).

The document itself is one JSON object. Here it is through `jq`, keeping the version, the info and the list of paths:

```bash
curl -s localhost:3000/openapi.json | jq '{openapi, info, paths: (.paths | keys)}'
```

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "organizations",
    "version": "0.0.0"
  },
  "paths": [
    "/media",
    "/media/{id}",
    "/media/{id}/file",
    "/memberships",
    "/memberships/{id}",
    "/modules",
    "/modules/{id}",
    "/organizations",
    "/organizations/{id}",
    "/permissions",
    "/permissions/{id}",
    "/profiles",
    "/profiles/{id}",
    "/teams",
    "/teams/{id}",
    "/users",
    "/users/{id}",
    "/users/{userId}/has-permissions"
  ]
}
```

The build also writes the same document to `.generated/openapi.json`.

> **Note:**
>
> Both routes are off in production. They follow `docs.enabled`, which defaults to `true` unless `production` is set (and `NODE_ENV=production` turns `production` on). When they are off, they answer 404 `Route not found`. Set `docs: { enabled: true }` to keep them in production.

## What gets documented

For each entity, the document has the CRUD routes with their request bodies, responses, errors, filters and paging parameters. The entity types become shared schemas under `components.schemas`, and named enums such as `ModuleAction` and `UserRole` get a schema of their own.

Routes are grouped by tag: the first segment of the path. The custom endpoint `GET /users/{userId}/has-permissions` lands in the `users` group, next to the generated user routes.

## The permission check endpoint

Here is how [the endpoint](/tutorial/permission-endpoint/) appears in the document:

```bash
curl -s localhost:3000/openapi.json | jq '.paths["/users/{userId}/has-permissions"]'
```

```json
{
  "get": {
    "tags": [
      "users"
    ],
    "operationId": "getUsersUserIdHasPermissions",
    "parameters": [
      {
        "name": "userId",
        "in": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "p",
        "in": "query",
        "required": true,
        "style": "form",
        "explode": true,
        "schema": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      {
        "name": "rule",
        "in": "query",
        "required": true,
        "schema": {
          "type": "string",
          "enum": [
            "all",
            "any"
          ]
        }
      },
      {
        "name": "organization",
        "in": "query",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "responses": {
      "200": {
        "description": "Success",
        "content": {
          "application/json": {
            "schema": {
              "type": "boolean"
            }
          }
        }
      }
    },
    "summary": "Check a user's permissions",
    "description": "Grants come from the user's active membership in the organization and from its active teams the user belongs to; `manage` also grants `view`."
  }
}
```

Each part comes from the endpoint file:

| In the document | From |
| --- | --- |
| `summary` | `@summary Check a user's permissions` |
| `description` | `@description Grants come from…` (it may span several lines) |
| The `userId` path parameter | The `[userId]` folder; path parameters are always required strings |
| The `p`, `rule` and `organization` query parameters | The `Query` type, the first argument of `Endpoint<Query, boolean>` |
| `required: true` on each query item | None of them is optional or has a `@default` |
| `p` as an array with `style: form` and `explode: true` | `p: string[]`: one `p=` key per value |
| `rule` with `enum: ["all", "any"]` | `rule: "all" \| "any"` |
| The `boolean` response schema | The second argument, `boolean` |
| The `users` tag and the `operationId` | The path: the first segment, and the method plus the path in PascalCase |

> **Tip:**
>
> `@summary` is a single line, the short label in the sidebar of `/docs`. Put the details in `@description`.

The JSDoc comments on the `Query` properties are for people reading the code; they are not copied into the document. If clients need to know the `<module slug>:<action>` format, say it in `@description`.

## Reference

- [JSDoc tags](/reference/tags/#endpoint-tags): `@summary`, `@description` and the other endpoint tags.
- [Configuration](/reference/config/): `docs.enabled` and `production`.
- [HTTP query parameters](/reference/http/): the parameters of the generated list and read routes.

## Next

The API works and is documented. Now make sure it keeps working: [Testing the API](/tutorial/testing/).
