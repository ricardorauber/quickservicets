---
title: Documentação da API
description: O documento OpenAPI gerado e a página do Scalar que o mostra.
sidebar:
  order: 42
---

Cada build escreve um documento OpenAPI 3.1 da sua API, e o servidor o mostra como uma página interativa. Você não escreve nada disso: entidades, endpoints personalizados, hooks, query items e arquivos são documentados a partir do código.

## O documento OpenAPI

`quickservice build` (e portanto o `dev`) grava o documento em `.generated/openapi.json`. Os campos `info.title` e `info.version` vêm do `package.json` do projeto. A mesma entrada sempre gera o mesmo documento, então você pode fazer commit dele ou compará-lo no CI para revisar mudanças na API.

O servidor também o serve:

```bash
curl localhost:3000/openapi.json
```

```json
// 200 OK (content-type: application/json), resumido
{"openapi":"3.1.0","info":{"title":"docs-check-0087","version":"0.0.0"},"tags":[{"name":"documents"},{"name":"files"},{"name":"media"},{"name":"organizations"}],"paths":{"/documents":{"get":{"tags":["documents"],"operationId":"listDocument", ...
```

Use-o para gerar clientes, importar no Postman ou no Insomnia, ou alimentar qualquer ferramenta OpenAPI.

## `/docs` com Scalar

Abra `http://localhost:3000/docs` no navegador para ver uma página que mostra o documento com o [Scalar](https://scalar.com): cada rota com parâmetros, corpos e respostas, e um cliente para testar requisições. A página carrega `@scalar/api-reference` do jsDelivr em uma versão fixa e o aponta para `/openapi.json`:

```bash
curl -i localhost:3000/docs
```

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
x-request-id: 01a146d1-f02d-743b-87f6-924220b5f947
Content-Length: 374

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>docs-check-0087 API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.3"></script>
  </body>
</html>
```

`/docs` e `/openapi.json` não rodam hooks e não aparecem no documento. Os dois caminhos são reservados: uma entidade cuja rota usa `/docs`, ou um endpoint personalizado para `GET /docs` ou `GET /openapi.json`, faz o build falhar.

## Desligando a documentação

`docs.enabled` decide se as duas rotas existem. O padrão é `true`, exceto em produção (`NODE_ENV=production` ou `production: true`), onde o padrão é `false`:

```ts check title="quickservice.config.ts"
import { defineConfig, sqliteAdapter } from "@quickservice/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  docs: { enabled: true },
});
```

Desligados, os dois caminhos respondem como qualquer rota desconhecida:

```bash
NODE_ENV=production bun .generated/server.ts
curl localhost:3000/docs
```

```json
// 404 Not Found
{"error":{"code":"NOT_FOUND","message":"Route not found"}}
```

O `.generated/openapi.json` é gravado de qualquer forma.

## O que é documentado

### Entidades

Cada entidade ganha quatro schemas em `components.schemas`:

| Schema | Usado em |
| --- | --- |
| `User` | Respostas: campos de sistema e todos os campos que não são `@hidden`. |
| `UserCreate` | Corpos de `POST`; os campos obrigatórios sem `@default` são obrigatórios. |
| `UserReplace` | Corpos de `PUT`; todos os campos obrigatórios são obrigatórios. |
| `UserUpdate` | Corpos de `PATCH`; nada é obrigatório. |

Os schemas dos campos seguem as tags: tipos, formatos (`date-time`, `uuid`, `email`, `uri`), enums (um enum com nome vira um schema compartilhado), padrões, tamanhos, quantidade de itens e faixas de números. Quando `@fields` ou `@exclude` restringem o que `list` ou `read` retornam, o documento adiciona `UserListItem` ou `UserRead` só com esses caminhos. Um schema `Error` compartilhado descreve todas as respostas de erro.

Cada rota gerada é uma operação com a tag da coleção da entidade (ou `<schema>/<coleção>`) e um `operationId` como `listUser`, `readUser` ou `createUser`. As operações de listagem documentam `limit`, `offset`, `sort`, `where` (com os campos filtráveis e os operadores deles), `fields`, `exclude` e `populate`; as de leitura documentam `fields`, `exclude` e `populate`. A descrição de `populate` lista os caminhos permitidos até `populate.maxDepth`, e os campos de referência nas respostas são tipados como o id ou o registro referenciado. As respostas de erro aparecem onde podem acontecer: 400, 404, e 409 para campos únicos e entidades referenciadas.

### Endpoints personalizados

O `@summary` e o `@description` de um endpoint personalizado viram os da operação. Quando o export padrão é tipado como `Endpoint<Body, Result>`, os tipos do corpo e do resultado viram os schemas da requisição e da resposta (tipos de entidade viram `$ref`s); em `GET` e `DELETE` o primeiro tipo é a query, e cada query item tipado vira um parâmetro de query com as suas tags:

```ts check title="endpoints/health/get.ts"
import type { Endpoint } from "@quickservice/core";

type HealthQuery = {
  /** @default false */
  verbose?: boolean;
};

type Health = { status: "ok"; uptimeSeconds?: number };

/**
 * @summary Health check
 * @description Reports that the service is up; `verbose=true` adds the uptime.
 */
const handler: Endpoint<HealthQuery, Health> = (repos, req) => {
  if (!req.queryItems.verbose) return { status: "ok" };
  return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
};

export default handler;
```

O build o documenta assim:

```json
{"tags":["health"],"operationId":"getHealth","parameters":[{"name":"verbose","in":"query","required":false,"schema":{"type":"boolean","default":false}}],"responses":{"200":{"description":"Success","content":{"application/json":{"schema":{"type":"object","properties":{"status":{"type":"string","enum":["ok"]},"uptimeSeconds":{"type":"number"}},"required":["status"]}}}}},"summary":"Health check","description":"Reports that the service is up; `verbose=true` adds the uptime."}
```

Sem generics, corpos e respostas são documentados como `{ "type": "object" }`. Um tipo que o build não consegue converter é documentado do mesmo jeito, com um aviso citando o arquivo. Um endpoint que sobrescreve uma rota gerada sem generics mantém a documentação da operação gerada.

### Hooks

Cada operação lista os hooks que rodam nela: uma linha `Hooks: <nome>(<args>)` na descrição e uma extensão `x-hooks`. Um hook também pode declarar as respostas que adiciona e que espera um token bearer:

```ts check title="hooks/authorized.ts"
import { definePreHook, HttpError } from "@quickservice/core";

export default definePreHook(
  (repos, req) => {
    if (!req.headers.get("authorization")?.startsWith("Bearer ")) throw new HttpError(401, "Missing token");
  },
  { docs: { responses: [401], security: "bearer" } },
);
```

Com `/** @authorized */` em `User`, `GET /users/{id}` é documentado com:

```json
{"description":"Hooks: authorized","x-hooks":[{"name":"authorized","phase":"pre","args":[]}],"security":[{"bearerAuth":[]}],"responses":{"200":{},"401":{},"404":{}}}
```

(resumido), e `components.securitySchemes` define `bearerAuth` (`type: http`, `scheme: bearer`) uma vez, então o Scalar mostra um campo para o token.

### Arquivos

- `POST` e `PUT` de uma entidade de arquivo documentam um corpo `multipart/form-data` com um `file` binário obrigatório e os campos próprios da entidade, além das respostas 413 e 415.
- `POST`, `PUT` e `PATCH` de uma entidade com campos de arquivo documentam um corpo JSON e um corpo multipart, em que cada campo de arquivo é binário (um array de itens binários, nos arrays), com `@maxSize`, `@accept` e os outros limites na descrição.
- Nos modos `proxy` e `signed`, `GET /<rota>/{id}/file` é documentado com uma resposta binária; no modo `signed`, também com os parâmetros `expires` e `signature` e a resposta 403.

Veja [Arquivos e armazenamento](/pt-br/guides/files/) para saber como essas rotas se comportam.

## Veja também

- [Configuração](/pt-br/reference/config/): `docs.enabled`, `production` e `populate.maxDepth`.
- [Tags](/pt-br/reference/tags/): `@summary`, `@description` e as tags refletidas nos schemas.
- [Parâmetros de query HTTP](/pt-br/reference/http/): os parâmetros das rotas geradas.

Próximo: [Configuração e logs](/pt-br/guides/configuration/).
