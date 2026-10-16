---
title: Perfis e organizações
description: Guarde listas ordenadas de referências com arrays de referências e anexe um arquivo.
sidebar:
  order: 3
---

Um perfil agrupa permissões sob um nome, e uma organização habilita um conjunto de módulos. Os dois precisam de um campo que guarda várias referências, então nesta página você conhece os **arrays de referências**, além de um campo de arquivo para o logo da organização.

<details>
<summary>As entidades até aqui</summary>

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

```ts check title="entities/Permission.ts"
import { Module, ModuleAction } from "./Module"

export type Permission = {
    module: Module
    action: ModuleAction
}
```

</details>

## A entidade Profile

Crie `entities/Profile.ts`:

```ts check title="entities/Profile.ts"
import { Permission } from "./Permission"

export type Profile = {
    slug: string
    permissions: Permission[]
}
```

`permissions: Permission[]` é um array de referências: uma lista ordenada de ids de permissões. O quickservice verifica isso para você:

- Todo id precisa existir, e o mesmo id não pode aparecer duas vezes.
- A ordem que você envia é a ordem que você recebe de volta.
- Quando você o omite na criação, ele é gravado como `[]`, mesmo que o campo não seja opcional.

## A entidade Organization

Crie `entities/Organization.ts`. As organizações ganham seus membros na próxima página, então por enquanto não têm o campo `members`:

```ts check title="entities/Organization.ts"
import type { Media } from "@quickservice/core"
import { Module } from "./Module"

export type Organization = {
    slug: string
    legalName: string
    name?: string
    logo?: Media;
    active: boolean
    modules: Module[]
}
```

- `name?` é opcional. Quando não tem valor, as respostas devolvem `null`.
- `logo?: Media` aponta para uma entidade de arquivo embutida, para imagens, áudio e vídeo. Você envia o arquivo na mesma requisição que cria a organização.
- `modules: Module[]` é outro array de referências.

## Experimente

Crie um perfil com duas permissões (antes, crie um módulo `reports` e uma permissão `view` para ele, como na página anterior):

```bash
curl -X POST localhost:3000/profiles -d '{"slug":"finance","permissions":["<manage-billing-id>","<view-reports-id>"]}'
```

```json
{
  "slug": "finance",
  "permissions": ["01a1…1cb4", "01a1…e65c"],
  "id": "01a1…d244",
  "createdAt": "2026-10-16T22:25:16.498Z",
  "updatedAt": "2026-10-16T22:25:16.498Z"
}
```

Enviar o mesmo id duas vezes falha na posição do segundo:

```bash
curl -X POST localhost:3000/profiles -d '{"slug":"dup","permissions":["<manage-billing-id>","<manage-billing-id>"]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "permissions[1]", "message": "Duplicate item" }]
  }
}
```

### Populate

Por padrão, as respostas trazem ids. Peça os registros com `populate` e desça mais um nível com um caminho com pontos:

```bash
curl "localhost:3000/profiles/<finance-id>?populate=permissions.module"
```

```json
{
  "id": "01a1…d244",
  "createdAt": "2026-10-16T22:25:16.498Z",
  "updatedAt": "2026-10-16T22:25:16.498Z",
  "slug": "finance",
  "permissions": [
    {
      "id": "01a1…1cb4",
      "createdAt": "2026-10-16T22:25:16.497Z",
      "updatedAt": "2026-10-16T22:25:16.497Z",
      "module": {
        "id": "01a1…208c",
        "createdAt": "2026-10-16T22:25:16.497Z",
        "updatedAt": "2026-10-16T22:25:16.497Z",
        "slug": "billing",
        "active": true
      },
      "action": "manage"
    },
    {
      "id": "01a1…e65c",
      "createdAt": "2026-10-16T22:25:16.497Z",
      "updatedAt": "2026-10-16T22:25:16.497Z",
      "module": {
        "id": "01a1…25d2",
        "createdAt": "2026-10-16T22:25:16.497Z",
        "updatedAt": "2026-10-16T22:25:16.497Z",
        "slug": "reports",
        "active": true
      },
      "action": "view"
    }
  ]
}
```

### Adicione e remova itens

Crie uma organização com um módulo:

```bash
curl -X POST localhost:3000/organizations \
  -d '{"slug":"acme","legalName":"Acme Inc.","active":true,"modules":["<billing-id>"]}'
```

```json
{
  "slug": "acme",
  "legalName": "Acme Inc.",
  "active": true,
  "modules": ["01a1…208c"],
  "id": "01a1…5802",
  "createdAt": "2026-10-16T22:25:16.499Z",
  "updatedAt": "2026-10-16T22:25:16.499Z",
  "name": null,
  "logo": null
}
```

O `PATCH` pode substituir a lista inteira ou alterá-la com `add` e `remove`, sem enviar o resto:

```bash
curl -X PATCH localhost:3000/organizations/<acme-id> -d '{"modules":{"add":["<reports-id>"]}}'
```

```json
{
  "slug": "acme",
  "legalName": "Acme Inc.",
  "active": true,
  "modules": ["01a1…208c", "01a1…25d2"],
  "id": "01a1…5802",
  "createdAt": "2026-10-16T22:25:16.499Z",
  "updatedAt": "2026-10-16T22:25:16.500Z",
  "name": null,
  "logo": null
}
```

### Filtre por um item

`contains` encontra os registros cujo array contém um id. `fields` deixa a resposta curta:

```bash
curl "localhost:3000/organizations?where[modules][contains]=<reports-id>&fields=slug,modules"
```

```json
{
  "data": [{ "slug": "acme", "modules": ["01a1…208c", "01a1…25d2"] }],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### Envie um logo

Envie um corpo `multipart/form-data` para criar o registro e enviar o arquivo em uma única requisição:

```bash
curl -X POST localhost:3000/organizations \
  -F slug=globex -F legalName="Globex LLC" -F active=true -F "logo=@./logo.png;type=image/png"
```

```json
{
  "slug": "globex",
  "legalName": "Globex LLC",
  "logo": "01a1…6f56",
  "active": true,
  "modules": [],
  "id": "01a1…936a",
  "createdAt": "2026-10-16T22:25:16.506Z",
  "updatedAt": "2026-10-16T22:25:16.506Z",
  "name": null
}
```

`modules` foi omitido, então vale `[]`. Faça o populate do logo para ver os dados do arquivo e sua URL:

```bash
curl "localhost:3000/organizations/<globex-id>?populate=logo&fields=slug,logo"
```

```json
{
  "slug": "globex",
  "logo": {
    "id": "01a1…6f56",
    "createdAt": "2026-10-16T22:25:16.505Z",
    "updatedAt": "2026-10-16T22:25:16.505Z",
    "filename": "logo.png",
    "mimeType": "image/png",
    "size": 4,
    "storage": "default",
    "url": "/media/01a1…6f56/file"
  }
}
```

### Excluir o que outros referenciam

O `module` de uma permissão é obrigatório, então um módulo que ainda é referenciado por permissões não pode ser excluído:

```bash
curl -X DELETE localhost:3000/modules/<reports-id>
```

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by permissions"
  }
}
```

Os arrays de referências funcionam ao contrário por padrão: excluir um registro remove seu id de todos os arrays que o contêm. A tag `@onDelete` muda os dois comportamentos.

## Saiba mais

- [Tags JSDoc](/pt-br/reference/tags/): `@onDelete`, `@minItems`, `@maxItems`, `@maxSize` e `@accept`.
- [Parâmetros de consulta HTTP](/pt-br/reference/http/): `populate`, `fields` e os operadores dos arrays de referências.
- [Erros](/pt-br/reference/errors/): o que cada mensagem significa.

## Próximo passo

Adicione usuários e ligue-os a organizações e times: [Usuários, vínculos e times](/pt-br/tutorial/users-memberships-and-teams/).
