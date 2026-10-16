---
title: Testando sua API no mesmo processo
description: Teste as rotas geradas e os endpoints customizados com bun test, num banco em memória, sem subir um servidor.
sidebar:
  order: 21
---

Você quer testes rápidos e confiáveis para a sua API: rotas de verdade, validação de verdade, hooks de verdade, mas sem abrir porta, sem subir banco e sem deixar dados para trás. O truque é fazer o build do projeto uma vez e montar a aplicação no próprio teste, com `createApp` e um banco em memória, enviando objetos `Request` por `server.fetch`.

## O projeto

Qualquer projeto serve. Esta receita usa uma entidade:

```ts check title="entities/Book.ts"
export type Book = {
  /** @minLength 1 */
  title: string;
  /** @unique */
  isbn: string;
  /** @min 1 */
  pages?: number;
};
```

Adicione ao `package.json` um script `test` que faz o build antes de testar, para que os testes sempre rodem com as entidades, endpoints e hooks atuais:

```json
{
  "scripts": {
    "test": "quickservice build && bun test"
  }
}
```

## O arquivo de teste

`tests/books.test.ts`:

```ts check title="tests/books.test.ts"
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, resolveConfig, type Server } from "@quickservice/core";
import { models } from "../.generated/models.ts";
import { crudRoutes, endpoints, hooks } from "../.generated/routes.ts";

type Json = Record<string, any>;
type Result = { status: number; body: Json; headers: Headers };

let server: Server;

beforeAll(async () => {
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig(
    {
      database,
      storage: { default: localStorage({ dir: mkdtempSync(join(tmpdir(), "uploads-")) }) },
      logger: { info() {}, warn() {}, error() {} },
    },
    {},
  );
  server = createApp({ models, crudRoutes, endpoints, hooks, config }).server;
});

/** Sends a request to the app in-process and parses the JSON response. */
async function call(method: string, path: string, body?: unknown): Promise<Result> {
  const request = new Request(`http://test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await server.fetch(request);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

/** Creates a record through the API, failing the test when the response is not 201. */
async function create(path: string, body: Json): Promise<Json> {
  const result = await call("POST", path, body);
  if (result.status !== 201) throw new Error(`POST ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;

describe("books", () => {
  test("creates and reads a book", async () => {
    const created = await call("POST", "/books", { title: "Dune", isbn: unique("isbn"), pages: 412 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "Dune", pages: 412 });

    const read = await call("GET", `/books/${created.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body.title).toBe("Dune");
  });

  test("rejects an invalid body with details per field", async () => {
    const result = await call("POST", "/books", { title: "", pages: 0 });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("VALIDATION_ERROR");
    expect(result.body.error.details).toEqual([
      { field: "title", message: "Must be at least 1 characters" },
      { field: "isbn", message: "Is required" },
      { field: "pages", message: "Must be at least 1" },
    ]);
  });

  test("rejects a duplicate isbn", async () => {
    const book = await create("/books", { title: "Emma", isbn: unique("isbn") });
    const result = await call("POST", "/books", { title: "Emma again", isbn: book.isbn });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("CONFLICT");
    expect(result.body.error.details).toEqual([{ field: "isbn", message: "Value already exists" }]);
  });

  test("filters the list", async () => {
    const book = await create("/books", { title: "Ulysses", isbn: unique("isbn") });
    const result = await call("GET", `/books?where[isbn][eq]=${book.isbn}`);
    expect(result.status).toBe(200);
    expect(result.body.total).toBe(1);
    expect(result.body.data[0].id).toBe(book.id);
  });

  test("updates and deletes", async () => {
    const book = await create("/books", { title: "Draft", isbn: unique("isbn") });
    const updated = await call("PATCH", `/books/${book.id}`, { title: "Final" });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe("Final");

    expect((await call("DELETE", `/books/${book.id}`)).status).toBe(204);
    const gone = await call("GET", `/books/${book.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe("NOT_FOUND");
  });
});
```

O que cada parte faz:

- **`.generated/models.ts` e `.generated/routes.ts`** são o que o `quickservice build` escreve: os modelos das entidades, as rotas CRUD geradas com seus hooks, seus endpoints customizados e as definições dos hooks. Importá-los dá ao teste exatamente a aplicação que o `bun run dev` serve.
- **`memoryAdapter()`** guarda os registros no processo do teste, então não há nada para migrar e cada execução começa vazia. `connect(models)` o prepara, como o servidor faz ao iniciar.
- **`resolveConfig(config, {})`** preenche todos os padrões. O segundo argumento é o ambiente; passar `{}` deixa as variáveis do seu terminal, como `DATABASE_SCHEMA`, `PORT` ou `NODE_ENV`, fora dos testes.
- **`localStorage` numa pasta temporária** mantém os uploads fora da pasta `uploads/` do projeto. Sem ele, o storage padrão grava lá.
- **O `logger` silencioso** descarta a linha JSON que cada requisição registra por padrão.
- **`call`** monta um `Request` e o passa para `server.fetch`, a mesma função que o `Bun.serve` chama. O host da URL nunca é usado.
- **`create`** cria registros pela API e falha de forma clara quando isso não dá certo, para que uma preparação quebrada nunca pareça uma asserção quebrada. **`unique`** mantém os valores `@unique` diferentes, já que os registros de todos os testes ficam no mesmo banco.

<details>
<summary>O que os dois arquivos gerados exportam</summary>

O build escreve os modelos e as rotas completos; estes são os exports que o teste usa:

```ts check title=".generated/models.ts"
import type { EntityModel } from "@quickservice/core";

export declare const models: EntityModel[];
```

```ts check title=".generated/routes.ts"
import type { AppEndpoint, CrudRouteEntry, HookDefinition } from "@quickservice/core";

export declare const crudRoutes: CrudRouteEntry[];
export declare const endpoints: AppEndpoint[];
export declare const hooks: Map<string, HookDefinition>;
```

</details>

## Rode

```bash
bun run test
```

```
$ quickservice build && bun test
Built 3 entities, 0 custom endpoints and 0 hooks.
bun test v1.4.2

 6 pass
 0 fail
 19 expect() calls
Ran 6 tests across 2 files.
```

As três entidades são `Book` e as embutidas `File` e `Media`; os seis testes são os cinco acima mais o de [Um banco novo para cada teste](#um-banco-novo-para-cada-teste). Se você já fez o build, `bun test` sozinho roda os testes com o último build, e `bun test -t duplicate` roda só os testes cujo nome corresponde.

## Como são as respostas

As asserções acima conferem estes corpos, que são os mesmos que um cliente recebe por HTTP:

```
POST /books {"title":"","pages":0}
→ 400 {"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"title","message":"Must be at least 1 characters"},{"field":"isbn","message":"Is required"},{"field":"pages","message":"Must be at least 1"}]}}

POST /books {"title":"Dune","isbn":"978-0441172719"}   (o isbn já existe)
→ 409 {"error":{"code":"CONFLICT","message":"Value already exists","details":[{"field":"isbn","message":"Value already exists"}]}}

GET /books?where[isbn][eq]=978-0441172719
→ 200 {"data":[{"id":"01a146d1-…","createdAt":"…","updatedAt":"…","title":"Dune","isbn":"978-0441172719","pages":412}],"total":1,"limit":20,"offset":0}

GET /books/01a10000-0000-7000-8000-000000000000
→ 404 {"error":{"code":"NOT_FOUND","message":"Book not found"}}

DELETE /books/<id>
→ 204 (sem corpo)
```

Sempre que puder, confira `body.error.code` e `body.error.details` em vez de `message`: o código depende só do status, e cada detalhe nomeia o campo. A [referência de erros](/pt-br/reference/errors/) lista todos os códigos e mensagens.

## Variações

### Um banco novo para cada teste

Quando um teste não pode ver os registros de outro, monte a aplicação em `beforeEach` em vez de `beforeAll`. Criar o adapter em memória é barato:

```ts check title="tests/fresh.test.ts"
import { beforeEach, expect, test } from "bun:test";
import { createApp, memoryAdapter, resolveConfig, type Server } from "@quickservice/core";
import { models } from "../.generated/models.ts";
import { crudRoutes, endpoints, hooks } from "../.generated/routes.ts";

let server: Server;

beforeEach(async () => {
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig({ database, logger: { info() {}, warn() {}, error() {} } }, {});
  server = createApp({ models, crudRoutes, endpoints, hooks, config }).server;
});

test("starts empty", async () => {
  const response = await server.fetch(new Request("http://test/books"));
  expect(await response.json()).toEqual({ data: [], total: 0, limit: 20, offset: 0 });
});
```

### Headers e upload de arquivos

Hooks costumam ler headers, e campos de arquivo recebem `multipart/form-data`. Faça o `call` aceitar headers e um corpo `FormData`; deixe o `content-type` de fora para `FormData`, assim o boundary é definido para você:

```ts check title="tests/call.ts"
import type { Server } from "@quickservice/core";

declare const server: Server;

export async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json", ...headers };
  }
  const response = await server.fetch(new Request(`http://test${path}`, init));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
}

// await call("GET", "/books", undefined, { authorization: "Bearer test-token" });
// const form = new FormData();
// form.append("file", new File([new Uint8Array(8)], "pic.png", { type: "image/png" }));
// await call("POST", "/media", form);
```

### Endpoints customizados e hooks

Nada muda: `endpoints` e `hooks` de `.generated/routes.ts` já os contêm, então o `call` chega a um endpoint customizado, e os hooks de cada rota rodam, exatamente como no servidor de desenvolvimento. Teste um hook pelas rotas que ele protege, enviando os headers que ele lê.

## Relacionados

- [API do repositório](/pt-br/reference/api/), para os `repos` que seus endpoints e hooks recebem
- [Configuração](/pt-br/reference/config/), para as chaves que o `resolveConfig` preenche
- [CLI: `build`](/pt-br/reference/cli/#build)
- [Referência HTTP](/pt-br/reference/http/), para os filtros de listagem
- [Erros](/pt-br/reference/errors/)

Anterior: [Schemas multi-tenant](/pt-br/recipes/multi-tenant/). Esta é a última receita; volte para os [Guias](/pt-br/guides/).
