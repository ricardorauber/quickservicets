---
title: Documentação da API em /docs
description: Navegue pelo documento OpenAPI gerado com o Scalar e veja como o endpoint customizado é documentado.
sidebar:
  order: 7
---

Você não escreveu nenhuma documentação da API, mas o serviço já tem uma. Todo build escreve um documento OpenAPI 3.1 com todas as rotas geradas e os endpoints customizados, e o servidor o serve junto com uma página de referência.

## Duas rotas

Com o servidor rodando (`bun run dev`), abra estas:

- **`/docs`**: uma referência interativa da API, renderizada pelo [Scalar](https://scalar.com). Navegue por todas as rotas, veja os parâmetros e schemas e envie requisições pela própria página.
- **`/openapi.json`**: o documento OpenAPI bruto, para clientes, geradores de código e outras ferramentas.

`/docs` é uma pequena página HTML que carrega o Scalar do jsDelivr e o aponta para `/openapi.json`:

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

O título vem do `name` do `package.json` (`organizations` no exemplo), e a versão do documento do `version` dele (`0.0.0` quando não há).

O documento em si é um único objeto JSON. Aqui ele passa pelo `jq`, mantendo a versão, o info e a lista de caminhos:

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
    "/files",
    "/files/{id}",
    "/files/{id}/file",
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

O build também escreve o mesmo documento em `.generated/openapi.json`.

:::note
As duas rotas ficam desligadas em produção. Elas seguem `docs.enabled`, que vale `true` a menos que `production` esteja ligado (e `production` vale, por padrão, `NODE_ENV === "production"`). Quando estão desligadas, respondem 404 `Route not found`. Defina `docs: { enabled: true }` para mantê-las em produção.
:::

## O que é documentado

Para cada entidade, o documento tem as rotas CRUD com seus corpos de requisição, respostas, erros, filtros e parâmetros de paginação. Os tipos das entidades viram schemas compartilhados em `components.schemas`, e enums nomeados como `ModuleAction` e `UserRole` ganham um schema próprio.

As rotas são agrupadas por tag: o primeiro segmento do caminho. O endpoint customizado `GET /users/{userId}/has-permissions` fica no grupo `users`, ao lado das rotas geradas de usuários.

## O endpoint de verificação de permissões

Veja como [o endpoint](/pt-br/tutorial/permission-endpoint/) aparece no documento:

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

Cada parte vem do arquivo do endpoint:

| No documento | Vem de |
| --- | --- |
| `summary` | `@summary Check a user's permissions` |
| `description` | `@description Grants come from…` (pode ocupar várias linhas) |
| O parâmetro de caminho `userId` | A pasta `[userId]`; parâmetros de caminho são sempre strings obrigatórias |
| Os parâmetros de query `p`, `rule` e `organization` | O tipo `Query`, o primeiro argumento de `Endpoint<Query, boolean>` |
| `required: true` em cada query item | Nenhum deles é opcional nem tem `@default` |
| `p` como array, com `style: form` e `explode: true` | `p: string[]`: uma chave `p=` por valor |
| `rule` com `enum: ["all", "any"]` | `rule: "all" \| "any"` |
| O schema `boolean` da resposta | O segundo argumento, `boolean` |
| A tag `users` e o `operationId` | O caminho: o primeiro segmento, e o método mais o caminho em PascalCase |

:::tip
`@summary` é uma única linha, o rótulo curto na barra lateral de `/docs`. Coloque os detalhes em `@description`.
:::

Os comentários JSDoc nas propriedades de `Query` são para quem lê o código; eles não são copiados para o documento. Se os clientes precisam conhecer o formato `<slug do módulo>:<ação>`, diga isso em `@description`.

## Referência

- [Tags JSDoc](/pt-br/reference/tags/#tags-de-endpoint): `@summary`, `@description` e as outras tags de endpoint.
- [Configuração](/pt-br/reference/config/): `docs.enabled` e `production`.
- [Parâmetros de query HTTP](/pt-br/reference/http/): os parâmetros das rotas geradas de listagem e leitura.

## Próximo passo

A API funciona e está documentada. Agora garanta que ela continue funcionando: [Testando a API](/pt-br/tutorial/testing/).
