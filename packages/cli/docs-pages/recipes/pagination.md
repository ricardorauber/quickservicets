# Pagination in custom endpoints

> Page through results in a custom endpoint with a fluent query, typed limit and offset items, and the same response shape as the generated list routes.

**The problem:** a custom endpoint returns a list that can grow without bound, such as an author's published articles. Clients need it in pages, with the total, and with the same `limit` and `offset` they already use on the generated list routes.

**The solution:** declare `limit` and `offset` as [typed query items](/reference/http/) with defaults and bounds, and end a [fluent query](/reference/api/#query) with `page({ limit, offset })`. It returns `{ data, total, limit, offset }`, exactly like `GET /<collection>`. Paging is by offset: no cursors to encode or store.

## The entities

```ts title="entities/Author.ts"
export type Author = {
  name: string;
};
```

```ts title="entities/Article.ts"
import type { Author } from "./Author";

export type Article = {
  title: string;
  author: Author;
  /** @default false */
  published: boolean;
  /** @index */
  publishedAt?: Date;
};
```

<details>
<summary>The generated types these snippets rely on (excerpt of <code>.generated/types.ts</code>)</summary>

The build writes this file for you; it is shown here so the snippets on this page type-check on their own.

```ts title=".generated/types.ts"
import type { One, Repository } from "@quickservicets/core";

export type Author = { id: string; createdAt: Date; updatedAt: Date; name: string };
export type AuthorReferences = Record<never, never>;

export type Article = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  author: string;
  published: boolean;
  publishedAt?: Date | null;
};
export type ArticleReferences = { author: One<Author, AuthorReferences> };

export interface GeneratedRepositories {
  authors: Repository<Author, AuthorReferences>;
  articles: Repository<Article, ArticleReferences>;
}

declare module "@quickservicets/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

</details>

## The endpoint

`GET /authors/:authorId/articles` lists an author's published articles, newest first, with an optional title search:

```ts title="endpoints/authors/[authorId]/articles/get.ts"
import type { Endpoint } from "@quickservicets/core";

type Query = {
  /** @integer @default 10 @min 1 @max 50 */
  limit?: number;
  /** @integer @default 0 @min 0 */
  offset?: number;
  /** @minLength 2 */
  search?: string;
};

type Item = { id: string; title: string; publishedAt?: Date | null };
type Page = { data: Item[]; total: number; limit: number; offset: number };

/**
 * @summary An author's published articles
 * @description Newest first; `search` matches part of the title.
 */
const handler: Endpoint<Query, Page> = async (repos, req) => {
  const { limit = 10, offset = 0, search } = req.queryItems;
  const authorId = req.params.authorId!;
  // 404 "Author not found" when the id is unknown.
  await repos.authors.where((a) => a.id.eq(authorId)).first();

  let articles = repos.articles.query().where((a) => a.author.eq(authorId).and(a.published.eq(true)));
  if (search) articles = articles.where((a) => a.title.contains(search));
  return articles
    .orderByDescending((a) => a.publishedAt)
    .thenBy((a) => a.title)
    .select("title", "publishedAt")
    .page({ limit, offset });
};

export default handler;
```

- The tags on `limit` and `offset` do the checking: a missing item gets its `@default`, and a fraction (`@integer`) or a value out of bounds is a 400 before the handler runs. The `= 10` and `= 0` only satisfy TypeScript, which sees the items as optional. `page()` itself accepts a `limit` from 1 to 100.
- `total` counts every match, not only the page; it ignores `limit` and `offset`.
- Results are always in a stable order: after your sort fields, the query adds `id` as a tie-breaker, so a record never shows up on two pages.
- `select` keeps the response small; `id` always comes along.

## Try it

Ana has five published articles and one draft. The first page, two per page:

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2"
```

```json
{"data":[{"id":"01a146dd-4304-7426-a07e-e1d8c8b71545","title":"Hooks in practice","publishedAt":"2026-09-29T00:00:00.000Z"},{"id":"01a146dd-4304-7425-8936-c50784a21791","title":"Paging without cursors","publishedAt":"2026-09-22T00:00:00.000Z"}],"total":5,"limit":2,"offset":0}
```

The next page starts where the last one ended: `offset` is the previous `offset` plus `limit`.

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2&offset=2"
```

```json
{"data":[{"id":"01a146dd-4304-7424-990a-7394b95d9e6c","title":"Testing with Bun","publishedAt":"2026-09-15T00:00:00.000Z"},{"id":"01a146dd-4304-7423-b5a1-50e04d4f357b","title":"Typed query items","publishedAt":"2026-09-08T00:00:00.000Z"}],"total":5,"limit":2,"offset":2}
```

The last page may be short:

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2&offset=4"
```

```json
{"data":[{"id":"01a146dd-4304-7422-9283-488d491a025d","title":"Getting started with Bun","publishedAt":"2026-09-01T00:00:00.000Z"}],"total":5,"limit":2,"offset":4}
```

There are more pages while `offset + data.length < total`. Past the end, `data` is empty and `total` is unchanged:

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2&offset=6"
```

```json
{"data":[],"total":5,"limit":2,"offset":6}
```

Without `limit`, the default of 10 applies, and `search` narrows the results and the total:

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?search=bun"
```

```json
{"data":[{"id":"01a146dd-4304-7424-990a-7394b95d9e6c","title":"Testing with Bun","publishedAt":"2026-09-15T00:00:00.000Z"},{"id":"01a146dd-4304-7422-9283-488d491a025d","title":"Getting started with Bun","publishedAt":"2026-09-01T00:00:00.000Z"}],"total":2,"limit":10,"offset":0}
```

Values outside the bounds are rejected with every problem listed:

```bash
curl -i "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=500&offset=-1&search=a"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"limit","message":"Must be at most 50"},{"field":"offset","message":"Must be at least 0"},{"field":"search","message":"Must be at least 2 characters"}]}}
```

Fractions are caught by `@integer`:

```bash
curl -i "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2.5&offset=1.5"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"limit","message":"Must be an integer"},{"field":"offset","message":"Must be an integer"}]}}
```

An unknown author is a 404:

```bash
curl -i "localhost:3000/authors/01a10000-0000-7000-8000-000000000000/articles"
```

```txt
HTTP/1.1 404 Not Found

{"error":{"code":"NOT_FOUND","message":"Author not found"}}
```

The API docs list the items with their defaults and bounds, from the same tags:

```bash
curl -s localhost:3000/openapi.json | jq '.paths["/authors/{authorId}/articles"].get.parameters'
```

```json
[
  {
    "name": "authorId",
    "in": "path",
    "required": true,
    "schema": {
      "type": "string"
    }
  },
  {
    "name": "limit",
    "in": "query",
    "required": false,
    "schema": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 10
    }
  },
  {
    "name": "offset",
    "in": "query",
    "required": false,
    "schema": {
      "type": "integer",
      "minimum": 0,
      "default": 0
    }
  },
  {
    "name": "search",
    "in": "query",
    "required": false,
    "schema": {
      "type": "string",
      "minLength": 2
    }
  }
]
```

## Compared with the generated list route

`GET /articles` pages the same way and returns the same shape. It takes filters, sorting and field selection as [query parameters](/reference/http/), and its `limit` goes from 1 to 100 (default 20):

```bash
curl -g "localhost:3000/articles?where[author][eq]=01a146dd-4300-7506-a94f-802fd580f626&where[published][eq]=true&sort=-publishedAt,title&fields=title,publishedAt&limit=2&offset=2"
```

```json
{"data":[{"title":"Testing with Bun","publishedAt":"2026-09-15T00:00:00.000Z"},{"title":"Typed query items","publishedAt":"2026-09-08T00:00:00.000Z"}],"total":5,"limit":2,"offset":2}
```

Use the generated route when clients may filter freely; write an endpoint when the rules are fixed (only published articles), when the query needs code, or when you want tighter limits.

## Variations

**Page numbers.** If clients think in pages, take `page` and `pageSize` and convert them:

```ts title="endpoints/authors/[authorId]/articles-by-page/get.ts"
import type { Endpoint } from "@quickservicets/core";

type Query = {
  /** @integer @default 1 @min 1 */
  page?: number;
  /** @integer @default 10 @min 1 @max 50 */
  pageSize?: number;
};

type Result = { data: { id: string; title: string }[]; page: number; pages: number; total: number };

/** @summary An author's published articles, by page number */
const handler: Endpoint<Query, Result> = async (repos, req) => {
  const { page = 1, pageSize = 10 } = req.queryItems;
  const result = await repos.articles
    .where((a) => a.author.eq(req.params.authorId!).and(a.published.eq(true)))
    .orderByDescending((a) => a.publishedAt)
    .select("title")
    .page({ limit: pageSize, offset: (page - 1) * pageSize });
  return { data: result.data, page, pages: Math.ceil(result.total / pageSize), total: result.total };
};

export default handler;
```

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles-by-page?page=2&pageSize=2"
```

```json
{"data":[{"id":"01a146dd-4304-7424-990a-7394b95d9e6c","title":"Testing with Bun"},{"id":"01a146dd-4304-7423-b5a1-50e04d4f357b","title":"Typed query items"}],"page":2,"pages":3,"total":5}
```

**A fixed slice.** For "the latest three", `take(3).toArray()` returns a plain array without a total. `skip` and `take` limit a query before `page()` pages it, so `take(30).page({ limit: 10, offset: 20 })` is the last page of the top 30.

**Only the count.** `count()` and `any()` answer without loading records, for badges such as "12 drafts".

**Very deep pages.** Offsets make the database skip rows, which grows slower on huge lists. When clients scroll forward only, let them send the last value they saw instead, as a `Date` query item, and filter by it: `where((a) => a.publishedAt.lt(before)).orderByDescending((a) => a.publishedAt).take(limit).toArray()`. Use a unique, ordered field, or add `thenBy` on one.

## Related

- [Repositories and queries](/reference/api/): `query`, `where`, `orderBy`, `select`, `skip`, `take`, `page`, `count`.
- [HTTP query parameters](/reference/http/): paging, sorting and filters on generated routes.
- [JSDoc tags](/reference/tags/): `@integer`, `@default`, `@min`, `@max`, `@minLength`, `@index`.
- [Errors](/reference/errors/): `Invalid query`.

Next: [Multi-tenant schemas](/recipes/multi-tenant/).
