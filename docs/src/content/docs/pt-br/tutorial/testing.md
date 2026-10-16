---
title: Testando a API
description: Rode os testes de API em processo do exemplo identity, veja como eles são montados e adicione seus próprios casos.
sidebar:
  order: 8
---

O exemplo identity vem com uma suíte de testes de API em `examples/identity/tests/api.test.ts`. Ela chama todas as rotas do projeto, incluindo a [verificação de permissões](/pt-br/tutorial/permission-endpoint/) e a [documentação da API](/pt-br/tutorial/api-docs/), e confere cada resultado: sucesso, erros de validação, 404, 405, 409 e assim por diante.

Ela roda **em processo**: sem servidor, sem porta, sem PostgreSQL. Os testes fazem o build do projeto, iniciam o app gerado num banco em memória e enviam objetos `Request` diretamente para ele.

## Rode

Em `examples/identity`:

```bash
bun test tests
```

```text
bun test v1.4.2 (744846f84)

 90 pass
 0 fail
 391 expect() calls
Ran 90 tests across 1 file. [1432.00ms]
```

`bun run test` faz o mesmo (é o script `test` do `package.json`). Para rodar só alguns testes, filtre pelo nome com `-t`:

```bash
bun test tests -t "has-permissions"
```

```text
bun test v1.4.2 (744846f84)

 4 pass
 86 filtered out
 0 fail
 20 expect() calls
Ran 4 tests across 1 file. [1248.00ms]
```

## O arquivo de testes

Este é o começo do arquivo, seus helpers e alguns dos casos. As linhas `// …` marcam as partes omitidas; todo o resto está exatamente como no exemplo.

```ts check title="tests/api.test.ts"
/**
 * End-to-end tests of every route of this project, with every outcome each one can produce.
 * Runs the generated app in-process on an in-memory database: `bun test` in examples/identity.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localStorage, memoryAdapter, resolveConfig } from "@quickservice/core";

const root = join(import.meta.dir, "..");
type Json = Record<string, any>;
type Result = { status: number; body: Json; headers: Headers };

let fetchApp: (request: Request) => Promise<Response>;

beforeAll(async () => {
  const built = Bun.spawnSync(["bun", "run", "quickservice", "build"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr.toString()}${built.stdout.toString()}`);
  const { models } = await import(join(root, ".generated/models.ts"));
  const { crudRoutes, endpoints, hooks } = await import(join(root, ".generated/routes.ts"));
  const openApi = await Bun.file(join(root, ".generated/openapi.json")).json();
  const database = memoryAdapter();
  await database.connect(models);
  const config = resolveConfig(
    {
      database,
      populate: { maxDepth: 3 },
      storage: { default: localStorage({ dir: mkdtempSync(join(tmpdir(), "identity-uploads-")) }) },
      logger: { info() {}, warn() {}, error() {} },
    },
    {},
  );
  const { server } = createApp({ models, crudRoutes, endpoints, hooks, config, openApi });
  fetchApp = (request) => server.fetch(request);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result> {
  const init: RequestInit = { method, headers };
  if (body instanceof FormData) init.body = body;
  else if (typeof body === "string") init.body = body;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetchApp(new Request(`http://x${path}`, init));
  const text = await response.text();
  let parsed: Json = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}
const get = (path: string) => call("GET", path);
const post = (path: string, body?: unknown, headers?: Record<string, string>) => call("POST", path, body, headers);
const patch = (path: string, body?: unknown) => call("PATCH", path, body);
const put = (path: string, body?: unknown) => call("PUT", path, body);
const del = (path: string) => call("DELETE", path);

/** Creates a record and returns it, failing the test when the response is not 201. */
async function create(path: string, body: unknown): Promise<Json> {
  const result = await post(path, body);
  if (result.status !== 201) throw new Error(`POST ${path} → ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}
const details = (result: Result) => (result.body.error?.details ?? []) as { field: string; message: string }[];
const detail = (result: Result, field: string) => details(result).find((item) => item.field === field)?.message;
const MISSING = "01a10000-0000-7000-8000-000000000000";
let counter = 0;
const unique = (prefix: string) => `${prefix}-${++counter}`;
// … png() and form() build files and multipart bodies …

/** A complete, valid graph of records to reference from the tests. */
async function world() {
  const billing = await create("/modules", { slug: unique("billing"), active: true });
  const reports = await create("/modules", { slug: unique("reports"), active: true });
  const legacy = await create("/modules", { slug: unique("legacy"), active: false });
  const org = await create("/organizations", { slug: unique("acme"), legalName: "Acme Ltd", active: true, modules: [billing.id, reports.id, legacy.id] });
  const inactiveOrg = await create("/organizations", { slug: unique("off"), legalName: "Off Ltd", active: false });
  const billingManage = await create("/permissions", { module: billing.id, action: "manage" });
  const reportsView = await create("/permissions", { module: reports.id, action: "view" });
  const legacyManage = await create("/permissions", { module: legacy.id, action: "manage" });
  const finance = await create("/profiles", { slug: unique("finance"), permissions: [billingManage.id, legacyManage.id] });
  const analyst = await create("/profiles", { slug: unique("analyst"), permissions: [reportsView.id] });
  const ana = await create("/users", { email: `${unique("ana")}@x.co` });
  const membership = await create("/memberships", { organization: org.id, user: ana.id, profiles: [finance.id], active: true });
  const team = await create("/teams", { organization: org.id, name: "Data", users: [ana.id], profiles: [analyst.id], active: true });
  return { billing, reports, legacy, org, inactiveOrg, billingManage, reportsView, legacyManage, finance, analyst, ana, membership, team };
}

// … the CRUD cases of every entity, then entity rules, media and files …

// ---------------------------------------------------------------------------------------------------------------
// The custom endpoint: GET /users/:userId/has-permissions.
// ---------------------------------------------------------------------------------------------------------------

describe("GET /users/:userId/has-permissions", () => {
  const check = (userId: string, query: string) => get(`/users/${userId}/has-permissions?${query}`);

  test("missing or invalid query items fail (400)", async () => {
    const { ana } = await world();
    const none = await check(ana.id, "");
    expect(none.status).toBe(400);
    expect(details(none).map((item) => [item.field, item.message])).toEqual([
      ["p", "Is required"],
      ["rule", "Is required"],
      ["organization", "Is required"],
    ]);
    const badRule = await check(ana.id, `organization=x&p=a:view&rule=some`);
    expect(detail(badRule, "rule")).toBe("Must be one of: all, any");
    const repeated = await check(ana.id, `organization=x&organization=y&p=a:view&rule=all`);
    expect(detail(repeated, "organization")).toBe("Parameter is repeated");
  });

  // … direct and team grants, inactive records, users without grants …
});

// ---------------------------------------------------------------------------------------------------------------
// Framework routes.
// ---------------------------------------------------------------------------------------------------------------

describe("framework routes", () => {
  test("unknown routes answer 404 Route not found", async () => {
    const result = await get("/nope");
    expect([result.status, result.body]).toEqual([404, { error: { code: "NOT_FOUND", message: "Route not found" } }]);
  });

  test("API docs are served", async () => {
    const document = await get("/openapi.json");
    expect([document.status, document.body.openapi]).toEqual([200, "3.1.0"]);
    expect(Object.keys(document.body.paths)).toContain("/users/{userId}/has-permissions");
    const page = await fetchApp(new Request("http://x/docs"));
    expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html; charset=utf-8"]);
  });
});
```

O resto desta página percorre o arquivo, de cima para baixo.

## Fazendo o build e iniciando o app

O `beforeAll` roda uma vez, antes de qualquer teste:

1. **Build.** Ele roda `quickservice build` na pasta do projeto, o que escreve `.generated/`: os modelos, as rotas (rotas CRUD, endpoints customizados e hooks), os tipos e o `openapi.json`. Quando o build falha, o erro é a saída do build, então uma entidade quebrada derruba a suíte na hora.
2. **Importa o código gerado.** Ele importa `models` de `.generated/models.ts`, `crudRoutes`, `endpoints` e `hooks` de `.generated/routes.ts`, e lê `.generated/openapi.json`. São as mesmas peças que `.generated/server.ts` junta para o servidor real.
3. **Conecta um banco em memória.** `memoryAdapter()` guarda tudo em memória, então cada execução começa vazia e não precisa de preparação nem limpeza. Os testes não leem `quickservice.config.ts`, então nunca tocam no PostgreSQL configurado no projeto.
4. **Resolve a configuração.** `resolveConfig` preenche todos os padrões, como faz para o servidor real. O teste passa o banco em memória, o mesmo `populate: { maxDepth: 3 }` do projeto, um storage local numa pasta temporária para os uploads e um logger que descarta os logs das requisições. O segundo argumento, `{}`, é o ambiente: um ambiente vazio, para que variáveis como `NODE_ENV` não mudem a configuração (a documentação da API continua ligada, por exemplo).
5. **Cria o app.** `createApp` retorna um `server` cujo `fetch(request)` trata um `Request` como o serviço rodando trataria: roteamento, hooks, validação, erros e tudo mais.

Nada escuta numa porta: `fetchApp` é `server.fetch`.

## Helpers

- `call(method, path, body?, headers?)` envia uma requisição e retorna `{ status, body, headers }`. Objetos vão como JSON, strings vão como estão (útil para JSON quebrado) e `FormData` vai como multipart. O corpo é lido como JSON quando possível.
- `get`, `post`, `patch`, `put` e `del` são atalhos para cada método.
- `create(path, body)` cria um registro com POST e o retorna, e lança um erro se a resposta não for 201. Use-o para preparar dados, não para testar a criação.
- `details(result)` retorna os `details` de um erro, e `detail(result, field)` a mensagem de um campo.
- `MISSING` é um id bem formado que nenhum registro tem, para os casos de 404.
- `unique(prefix)` retorna um valor novo a cada chamada, como `acme-12`. Todos os testes do arquivo compartilham um banco, então slugs e emails únicos mantêm os registros de cada teste separados dos outros.
- `world()` cria um grafo completo: três módulos (um inativo), uma organização ativa e uma inativa, permissões, os perfis `finance` e `analyst`, a usuária Ana, a membership dela com `finance` e o time "Data" dela com `analyst`. Cada chamada cria um grafo novo, então um teste pode alterar esses registros à vontade.

## Como os casos são organizados

O arquivo tem cinco partes, cada uma com um comentário de destaque:

1. **Rotas CRUD geradas**, conferidas uma vez por entidade com `describe.each(crudCases)`. Cada `CrudCase` traz um corpo válido, um campo obrigatório, um campo com tipo errado (e sua mensagem) e uma alteração válida. Toda entidade recebe os mesmos casos: criação (201), corpos inválidos (400), listagem com paginação, ordenação, filtros e seleção de campos, parâmetros de query inválidos, leitura (200 e 404), PATCH, PUT, DELETE (204, depois 404) e métodos não suportados (405 com `Allow`).
2. **Regras das entidades**: padrões, lados derivados das relações, arrays de referências, regras de exclusão (409), uploads junto com o registro, `populate` e seu limite de profundidade.
3. **Media e arquivos**: upload, streaming, renomear, substituir, excluir, e os erros 413 e 415.
4. **O endpoint customizado**: os erros de query items mostrados acima, depois permissões diretas e de times com `all` e `any`, módulos, memberships, times e organizações inativos, e usuários sem permissões.
5. **Rotas do framework**: rotas desconhecidas (404) e a documentação da API.

## Adicionando um caso

Adicione um `test` ao `describe` a que ele pertence, ou um novo `describe` para uma rota nova:

1. Prepare os dados com `world()`, ou com `create(...)` e `unique(...)` para o resto.
2. Chame a rota com `get`, `post`, `patch`, `put`, `del` ou `call`.
3. Confira `status`, `body` e, nos erros, `detail(result, field)`. Compare com as mensagens reais da [referência de erros](/pt-br/reference/errors/).

Depois de adicionar uma entidade, adicione também um `CrudCase` a `crudCases`: ela ganha todos os casos das rotas geradas de graça.

Como o `beforeAll` faz o build do projeto, entidades e endpoints novos entram na próxima execução, sem um passo de build separado.

:::tip
As mensagens da suíte são o contrato da API. Quando um teste compara uma mensagem inteira, como `"Must be one of: all, any"`, um cliente que dependa dela vai quebrar no mesmo lugar.
:::

## Referência

- [CLI](/pt-br/reference/cli/): `quickservice build` e o que ele escreve.
- [Configuração](/pt-br/reference/config/): todas as chaves que `resolveConfig` preenche, como `populate.maxDepth` e `storage`.
- [Erros](/pt-br/reference/errors/): todos os status, códigos e mensagens que os testes conferem.
- [Parâmetros de query HTTP](/pt-br/reference/http/): os parâmetros de paginação, ordenação e filtro das rotas de listagem.

## Próximo passo

Esse é o exemplo identity inteiro: um modelo, um endpoint customizado, sua documentação e seus testes. Os [Guias](/pt-br/guides/) explicam cada recurso em detalhes.
