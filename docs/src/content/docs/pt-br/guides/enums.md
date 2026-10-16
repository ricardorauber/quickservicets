---
title: Enums e aliases de união
description: Restrinja um campo a um conjunto fixo de strings com uniões, enums ou aliases compartilhados.
sidebar:
  order: 11
---

Um campo enum aceita um valor de uma lista fixa de strings. Você pode escrever a lista inline, como um `enum` do TypeScript, ou como um alias de tipo compartilhado por várias entidades. Todas as formas se comportam igual nas requisições, nos filtros e no banco; elas só mudam o nome que o código gerado e a documentação da API usam.

## Quatro jeitos de escrever um enum

```ts check title="entities/enums.ts"
// A string enum: the values are the strings.
export enum Status {
  Draft = "draft",
  Published = "published",
}

// An enum without initializers: the member names are the values.
export enum Priority {
  low,
  normal,
  high,
}

// An alias of a string union.
export type Visibility = "public" | "private";
```

```ts check title="entities/Post.ts"
import { Priority, Status, type Visibility } from "./enums";

export type Post = {
  title: string;
  /** @default Status.Draft */
  status: Status;
  /** @default Priority.normal */
  priority: Priority;
  /** @default 'public' */
  visibility: Visibility;
  // An inline union.
  kind?: "news" | "opinion";
  labels?: Status[];
};
```

- **União inline** (`"news" | "opinion"`): o mais rápido para uma lista usada por um só campo.
- **Enum de strings** (`Status`): os valores são os inicializadores, `"draft"` e `"published"`. No código você escreve `Status.Draft`.
- **Enum sem inicializadores** (`Priority`): os valores são os nomes dos membros, `"low"`, `"normal"` e `"high"`. Em tempo de execução o TypeScript numera esses membros (`Priority.low` é `0`), mas o quickservice nunca usa os números.
- **Alias de união** (`Visibility`): uma união com nome, sem objeto em tempo de execução.

Enums e aliases também funcionam em arrays (`labels?: Status[]`) e dentro de objetos aninhados (`meta: { status: Status }`).

## Onde declarar

Um enum ou alias pode ficar no arquivo da entidade, em qualquer outro arquivo do projeto (como `shared/visibility.ts`) ou num arquivo próprio dentro de `entities/`. Um arquivo em `entities/` que exporta só enums e uniões de strings, como o `entities/enums.ts` acima, é compartilhado pelas entidades e não é uma entidade, então o nome dele não precisa ser PascalCase.

Seja onde for, a declaração precisa ser **exportada**. O build rejeita os enums que não consegue usar, apontando o arquivo, o campo e o enum:

```text
entities/Post.ts: field "status" uses Status, which must be exported
entities/Post.ts: field "level" uses enum Level, whose members must all have string values or all have none
entities/Post.ts: field "s" uses enum Status, which repeats the value "x"
```

A segunda mensagem vale para inicializadores numéricos (`enum Level { Low = 1 }`) e para enums que misturam membros com e sem valor (`enum Level { Low, High = "high" }`).

## Valores padrão

[`@default`](/pt-br/reference/tags/#default) aceita o valor, entre aspas simples, ou um membro do próprio enum do campo:

- `/** @default 'draft' */` e `/** @default Status.Draft */` dão `"draft"`.
- `/** @default Priority.normal */` dá `"normal"`.
- Um membro que não existe, ou um membro de outro enum, para o build com um erro de `@default` inválido.

## Nas requisições e nos filtros

Os clientes sempre enviam e recebem os valores, nunca os nomes dos membros de enums de strings e nunca números. Com a entidade `Post` acima, os padrões preenchem o que o corpo omite:

```bash
curl -X POST localhost:3000/posts -d '{"title":"Hello"}'
```

```json
{
  "title": "Hello",
  "status": "draft",
  "priority": "normal",
  "visibility": "public",
  "id": "01a146db-1bd4-72f5-85a9-db325b08d9e7",
  "createdAt": "2026-10-16T22:35:27.060Z",
  "updatedAt": "2026-10-16T22:35:27.060Z",
  "kind": null,
  "labels": null
}
```

Um nome de membro (`"Draft"`), um número ou um valor desconhecido falham com a lista dos valores aceitos:

```bash
curl -X POST localhost:3000/posts -d '{"title":"Bye","status":"Draft","priority":2,"labels":["draft","archived"]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "status", "message": "Must be one of: draft, published" },
      { "field": "priority", "message": "Must be one of: low, normal, high" },
      { "field": "labels[1]", "message": "Must be one of: draft, published" }
    ]
  }
}
```

Os filtros também usam os valores. Depois de criar também um post com `"status": "published"`, `"priority": "high"` e o título `Launch`:

```bash
curl "localhost:3000/posts?where[status][eq]=published&fields=title,status,priority"
```

```json
{
  "data": [{ "title": "Launch", "status": "published", "priority": "high" }],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

```bash
curl "localhost:3000/posts?where[priority][eq]=2"
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query",
    "details": [{ "field": "where[priority][eq]", "message": "Must be one of: low, normal, high" }]
  }
}
```

Os operadores que cada campo enum aceita estão na [referência de parâmetros de consulta HTTP](/pt-br/reference/http/#operadores-de-filtro-por-tipo-de-campo).

## Tipos gerados

O build tipa os campos enum com as suas declarações, então o código as usa diretamente. Esta é a parte de `Post` em `.generated/types.ts` (um trecho):

```ts check title=".generated/types.ts"
// Generated by quickservice build. Do not edit.
import type { Many, One, Repository } from "@quickservice/core";
import type { Status } from "../entities/enums.ts";
import type { Visibility } from "../entities/enums.ts";

export type Post = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  status: Status;
  priority: "low" | "normal" | "high";
  visibility: Visibility;
  kind?: "news" | "opinion" | null;
  labels?: Array<Status> | null;
};

export type PostCreate = {
  title: string;
  status?: Status;
  priority?: "low" | "normal" | "high";
  visibility?: Visibility;
  kind?: "news" | "opinion" | null;
  labels?: Array<Status> | null;
};

export type PostUpdate = {
  title?: string;
  status?: Status;
  priority?: "low" | "normal" | "high";
  visibility?: Visibility;
  kind?: "news" | "opinion" | null;
  labels?: Array<Status> | null;
};

export type PostReferences = Record<never, never>;

export interface GeneratedRepositories {
  posts: Repository<Post, PostReferences, PostCreate, PostUpdate>;
}

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

- Enums de strings e aliases são importados e usados pelo nome: `status: Status`.
- Enums sem inicializadores viram a união dos seus nomes (`"low" | "normal" | "high"`), porque os membros deles são números em tempo de execução.
- Uniões inline continuam uniões inline.

Então, num endpoint, você escreve `Status.Published` para um enum de strings e o nome puro para um enum sem inicializadores:

```ts check title="endpoints/posts/announcements/post.ts"
import type { Endpoint } from "@quickservice/core";
import { Status } from "../../../entities/enums";

/** @summary Publish an urgent announcement */
const handler: Endpoint<{ title: string }> = async (repos, req, res) => {
  const { title } = await req.json();
  res.status(201);
  return repos.posts.create({ title, status: Status.Published, priority: "high" });
};

export default handler;
```

```bash
curl -X POST localhost:3000/posts/announcements -d '{"title":"We are live"}'
```

```json
{
  "title": "We are live",
  "status": "published",
  "priority": "high",
  "visibility": "public",
  "id": "01a146d9-b620-7150-9cce-56f6470a4771",
  "createdAt": "2026-10-16T22:33:55.493Z",
  "updatedAt": "2026-10-16T22:33:55.493Z",
  "kind": null,
  "labels": null
}
```

Escrever o membro de um enum sem inicializadores é um erro de tipo, porque `Priority.high` é o número `2`:

```ts
repos.posts.create({ title, priority: Priority.high });
// error TS2322: Type 'Priority.high' is not assignable to type '"normal" | "high" | "low" | undefined'.
```

## Na documentação da API

Cada enum ou alias com nome aparece uma vez no documento OpenAPI, como um schema compartilhado em `components.schemas`, e todo campo que o usa aponta para ele com `$ref`, em respostas, corpos de requisição, campos aninhados e itens de array. Uniões inline continuam inline. Para a entidade `Post`:

```json
{
  "Status": { "type": "string", "enum": ["draft", "published"] },
  "Priority": { "type": "string", "enum": ["low", "normal", "high"] },
  "Visibility": { "type": "string", "enum": ["public", "private"] }
}
```

```json
{
  "status": { "$ref": "#/components/schemas/Status", "default": "draft" },
  "priority": { "$ref": "#/components/schemas/Priority", "default": "normal" },
  "visibility": { "$ref": "#/components/schemas/Visibility", "default": "public" },
  "kind": { "type": ["string", "null"], "enum": ["news", "opinion", null] },
  "labels": { "type": ["array", "null"], "items": { "$ref": "#/components/schemas/Status" } }
}
```

Um campo opcional que usa diretamente um enum com nome, como `visibility?: Visibility`, é documentado como `oneOf` entre o `$ref` e `{ "type": "null" }`. Quando o nome de um enum coincide com outro schema do documento (uma entidade, outro enum com o mesmo nome ou um nome gerado como `UserCreate` ou `Error`), os campos dele voltam a usar um `enum` inline.

**Próximo:** [Validação e mensagens de erro](/pt-br/guides/validation/)
