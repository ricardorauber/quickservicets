---
title: Paginação em endpoints próprios
description: Pagine resultados em um endpoint próprio com uma consulta fluente, itens limit e offset tipados e o mesmo formato de resposta das rotas de listagem geradas.
sidebar:
  order: 12
---

**O problema:** um endpoint próprio devolve uma lista que pode crescer sem limite, como os artigos publicados de um autor. Os clientes precisam dela em páginas, com o total, e com os mesmos `limit` e `offset` que já usam nas rotas de listagem geradas.

**A solução:** declare `limit` e `offset` como [itens de query tipados](/pt-br/reference/http/) com padrões e limites, e termine uma [consulta fluente](/pt-br/reference/api/#query) com `page({ limit, offset })`. Ela devolve `{ data, total, limit, offset }`, igual a `GET /<coleção>`. A paginação é por offset: nenhum cursor para codificar ou guardar.

## As entidades

```ts check title="entities/Author.ts"
export type Author = {
  name: string;
};
```

```ts check title="entities/Article.ts"
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
<summary>Os tipos gerados de que estes trechos dependem (trecho de <code>.generated/types.ts</code>)</summary>

O build escreve este arquivo para você; ele aparece aqui para que os trechos desta página passem na checagem de tipos sozinhos.

```ts check title=".generated/types.ts"
import type { One, Repository } from "@quickservice/core";

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

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

</details>

## O endpoint

Itens de query numéricos aceitam qualquer número, então `offset=1.5` passa pelas tags. Uma pequena função transforma frações no mesmo 400 das outras checagens, em vez de deixar `page()` falhar com 500:

```ts check title="lib/paging.ts"
import { HttpError } from "@quickservice/core";

/** Fails with 400 `Invalid query` when a paging item is not a whole number. */
export function assertWhole(items: Record<string, number>): void {
  const details = Object.entries(items)
    .filter(([, value]) => !Number.isInteger(value))
    .map(([field]) => ({ field, message: "Must be an integer" }));
  if (details.length > 0) throw new HttpError(400, "Invalid query", { details });
}
```

`GET /authors/:authorId/articles` lista os artigos publicados de um autor, do mais novo para o mais antigo, com busca opcional no título:

```ts check title="endpoints/authors/[authorId]/articles/get.ts"
import type { Endpoint } from "@quickservice/core";
import { assertWhole } from "../../../../lib/paging.ts";

type Query = {
  /** @default 10 @min 1 @max 50 */
  limit?: number;
  /** @default 0 @min 0 */
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
  assertWhole({ limit, offset });
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

- As tags em `limit` e `offset` fazem a checagem: um item ausente recebe seu `@default`, e um valor fora dos limites dá 400 antes de o handler rodar. O `= 10` e o `= 0` só satisfazem o TypeScript, que vê os itens como opcionais. O próprio `page()` aceita `limit` de 1 a 100.
- `total` conta todos os resultados, não só a página; ele ignora `limit` e `offset`.
- Os resultados sempre vêm em ordem estável: depois dos seus campos de ordenação, a consulta acrescenta `id` como desempate, então um registro nunca aparece em duas páginas.
- `select` mantém a resposta pequena; `id` sempre vem junto.

## Experimente

Ana tem cinco artigos publicados e um rascunho. A primeira página, dois por página:

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2"
```

```json
{"data":[{"id":"01a146dd-4304-7426-a07e-e1d8c8b71545","title":"Hooks in practice","publishedAt":"2026-09-29T00:00:00.000Z"},{"id":"01a146dd-4304-7425-8936-c50784a21791","title":"Paging without cursors","publishedAt":"2026-09-22T00:00:00.000Z"}],"total":5,"limit":2,"offset":0}
```

A página seguinte começa onde a anterior terminou: `offset` é o `offset` anterior mais `limit`.

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2&offset=2"
```

```json
{"data":[{"id":"01a146dd-4304-7424-990a-7394b95d9e6c","title":"Testing with Bun","publishedAt":"2026-09-15T00:00:00.000Z"},{"id":"01a146dd-4304-7423-b5a1-50e04d4f357b","title":"Typed query items","publishedAt":"2026-09-08T00:00:00.000Z"}],"total":5,"limit":2,"offset":2}
```

A última página pode vir incompleta:

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2&offset=4"
```

```json
{"data":[{"id":"01a146dd-4304-7422-9283-488d491a025d","title":"Getting started with Bun","publishedAt":"2026-09-01T00:00:00.000Z"}],"total":5,"limit":2,"offset":4}
```

Há mais páginas enquanto `offset + data.length < total`. Depois do fim, `data` vem vazio e `total` não muda:

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2&offset=6"
```

```json
{"data":[],"total":5,"limit":2,"offset":6}
```

Sem `limit`, vale o padrão de 10, e `search` restringe os resultados e o total:

```bash
curl "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?search=bun"
```

```json
{"data":[{"id":"01a146dd-4304-7424-990a-7394b95d9e6c","title":"Testing with Bun","publishedAt":"2026-09-15T00:00:00.000Z"},{"id":"01a146dd-4304-7422-9283-488d491a025d","title":"Getting started with Bun","publishedAt":"2026-09-01T00:00:00.000Z"}],"total":2,"limit":10,"offset":0}
```

Valores fora dos limites são rejeitados, com todos os problemas listados:

```bash
curl -i "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=500&offset=-1&search=a"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"limit","message":"Must be at most 50"},{"field":"offset","message":"Must be at least 0"},{"field":"search","message":"Must be at least 2 characters"}]}}
```

Frações são barradas por `assertWhole`:

```bash
curl -i "localhost:3000/authors/01a146dd-4300-7506-a94f-802fd580f626/articles?limit=2.5&offset=1.5"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid query","details":[{"field":"limit","message":"Must be an integer"},{"field":"offset","message":"Must be an integer"}]}}
```

Um autor desconhecido dá 404:

```bash
curl -i "localhost:3000/authors/01a10000-0000-7000-8000-000000000000/articles"
```

```txt
HTTP/1.1 404 Not Found

{"error":{"code":"NOT_FOUND","message":"Author not found"}}
```

A documentação da API lista os itens com seus padrões e limites, a partir das mesmas tags:

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
      "type": "number",
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
      "type": "number",
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

## Comparado com a rota de listagem gerada

`GET /articles` pagina do mesmo jeito e devolve o mesmo formato. Ela recebe filtros, ordenação e seleção de campos como [parâmetros de query](/pt-br/reference/http/), e seu `limit` vai de 1 a 100 (padrão 20):

```bash
curl "localhost:3000/articles?where[author][eq]=01a146dd-4300-7506-a94f-802fd580f626&where[published][eq]=true&sort=-publishedAt,title&fields=title,publishedAt&limit=2&offset=2"
```

```json
{"data":[{"title":"Testing with Bun","publishedAt":"2026-09-15T00:00:00.000Z"},{"title":"Typed query items","publishedAt":"2026-09-08T00:00:00.000Z"}],"total":5,"limit":2,"offset":2}
```

Use a rota gerada quando os clientes podem filtrar livremente; escreva um endpoint quando as regras são fixas (só artigos publicados), quando a consulta precisa de código ou quando você quer limites mais apertados.

## Variações

**Números de página.** Se os clientes pensam em páginas, receba `page` e `pageSize` e converta-os:

```ts check title="endpoints/authors/[authorId]/articles-by-page/get.ts"
import type { Endpoint } from "@quickservice/core";
import { assertWhole } from "../../../../lib/paging.ts";

type Query = {
  /** @default 1 @min 1 */
  page?: number;
  /** @default 10 @min 1 @max 50 */
  pageSize?: number;
};

type Result = { data: { id: string; title: string }[]; page: number; pages: number; total: number };

/** @summary An author's published articles, by page number */
const handler: Endpoint<Query, Result> = async (repos, req) => {
  const { page = 1, pageSize = 10 } = req.queryItems;
  assertWhole({ page, pageSize });
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

**Uma fatia fixa.** Para "os três mais recentes", `take(3).all()` devolve um array simples, sem total. `skip` e `take` limitam a consulta antes de `page()` paginá-la, então `take(30).page({ limit: 10, offset: 20 })` é a última página dos 30 primeiros.

**Só a contagem.** `count()` e `any()` respondem sem carregar registros, para selos como "12 rascunhos".

**Páginas muito profundas.** Offsets fazem o banco pular linhas, o que fica mais lento em listas enormes. Quando os clientes só avançam, deixe que enviem o último valor que viram, como um item de query `Date`, e filtre por ele: `where((a) => a.publishedAt.lt(before)).orderByDescending((a) => a.publishedAt).take(limit).all()`. Use um campo único e ordenado, ou acrescente `thenBy` com um.

## Relacionados

- [Repositórios e consultas](/pt-br/reference/api/): `query`, `where`, `orderBy`, `select`, `skip`, `take`, `page`, `count`.
- [Parâmetros de query HTTP](/pt-br/reference/http/): paginação, ordenação e filtros nas rotas geradas.
- [Tags JSDoc](/pt-br/reference/tags/): `@default`, `@min`, `@max`, `@minLength`, `@index`.
- [Erros](/pt-br/reference/errors/): `Invalid query`.

Próxima: [Schemas multi-tenant](/pt-br/recipes/multi-tenant/).
