---
title: Módulos e permissões
description: Escreva suas primeiras entidades, uma referência e um enum.
sidebar:
  order: 2
---

Um módulo é uma parte do produto, como `billing`. Uma permissão diz o que alguém pode fazer com um módulo: gerenciá-lo (`manage`) ou apenas visualizá-lo (`view`). Nesta página você escreve as duas entidades e conhece dois tipos de campo: uma referência e um enum.

## A entidade Module

Uma entidade é um `type` exportado em um arquivo dentro de `entities/`. Crie `entities/Module.ts`:

```ts check title="entities/Module.ts"
export enum ModuleAction {
    manage,
    view
}

export type Module = {
    slug: string
    active: boolean
}
```

`Module` ganha as rotas `/modules` e `/modules/<id>`, e todo registro também tem `id`, `createdAt` e `updatedAt`. O arquivo também exporta `ModuleAction`, que a permissão usa a seguir. Um enum não é uma entidade, então não ganha rotas.

## Um enum sem inicializadores

`ModuleAction` não tem valores depois dos membros. Nesse caso, o quickservice usa os nomes dos membros como valores, então a API aceita e devolve `"manage"` e `"view"`, nunca `0` ou `1`.

As outras formas com strings funcionam do mesmo jeito. Todas estas são válidas:

```ts check
// Um enum de strings
export enum Status { Draft = "draft", Published = "published" }

// Um alias de uma união de strings
export type Visibility = "public" | "private"

export type Post = {
    status: Status
    visibility: Visibility
    // Uma união inline
    kind: "news" | "event"
}
```

O build falha para enums que não são exportados, que usam valores numéricos, que misturam membros com e sem valor ou que repetem um valor.

## A entidade Permission

Crie `entities/Permission.ts`:

```ts check title="entities/Permission.ts"
import { Module, ModuleAction } from "./Module"

export type Permission = {
    module: Module
    action: ModuleAction
}
```

- `module: Module` é uma **referência**: guarda o id de um módulo. O módulo precisa existir quando você salva a permissão.
- `action: ModuleAction` é um **campo enum**: aceita apenas `"manage"` ou `"view"`.

## Experimente

O servidor de desenvolvimento detecta os arquivos novos. Crie um módulo:

```bash
curl -X POST localhost:3000/modules -d '{"slug":"billing","active":true}'
```

Ele responde `201 Created`:

```json
{
  "slug": "billing",
  "active": true,
  "id": "01a1…ed1e",
  "createdAt": "2026-10-16T22:25:12.262Z",
  "updatedAt": "2026-10-16T22:25:12.262Z"
}
```

:::tip
Os ids aparecem encurtados com `…` nestas páginas. Nas suas requisições, troque marcadores como `<billing-id>` pelos ids completos das suas próprias respostas.
:::

Crie uma permissão que aponta para ele:

```bash
curl -X POST localhost:3000/permissions -d '{"module":"<billing-id>","action":"manage"}'
```

```json
{
  "module": "01a1…ed1e",
  "action": "manage",
  "id": "01a1…73da",
  "createdAt": "2026-10-16T22:25:12.263Z",
  "updatedAt": "2026-10-16T22:25:12.263Z"
}
```

Uma ação fora do enum falha com `400`, assim como um número como `0`:

```bash
curl -X POST localhost:3000/permissions -d '{"module":"<billing-id>","action":"edit"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "action", "message": "Must be one of: manage, view" }]
  }
}
```

Um id de módulo que não existe também falha:

```bash
curl -X POST localhost:3000/permissions -d '{"module":"nope","action":"view"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "module", "message": "Referenced record not found" }]
  }
}
```

Depois de criar também uma permissão `view` para `billing`, filtre pelo valor do enum:

```bash
curl "localhost:3000/permissions?where[action][eq]=view"
```

```json
{
  "data": [
    {
      "id": "01a1…683f",
      "createdAt": "2026-10-16T22:25:12.263Z",
      "updatedAt": "2026-10-16T22:25:12.263Z",
      "module": "01a1…ed1e",
      "action": "view"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

:::caution
No seu próprio código, como em endpoints próprios, escreva o valor como string (`"manage"`). `ModuleAction.manage` é o número `0` em tempo de execução, e os tipos gerados o rejeitam.
:::

:::note
O banco em memória começa vazio toda vez que o servidor de desenvolvimento reinicia, por exemplo depois que você edita uma entidade. Quando isso acontecer, recrie os registros de que precisar.
:::

## Saiba mais

- [Tags JSDoc](/pt-br/reference/tags/): todas as tags que um campo aceita.
- [Parâmetros de consulta HTTP](/pt-br/reference/http/): os operadores de filtro de cada tipo de campo.
- [Erros](/pt-br/reference/errors/): todos os códigos e mensagens de erro.

## Próximo passo

Agrupe permissões em perfis e dê módulos às organizações: [Perfis e organizações](/pt-br/tutorial/profiles-and-organizations/).
