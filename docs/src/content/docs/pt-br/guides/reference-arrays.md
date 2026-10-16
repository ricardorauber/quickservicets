---
title: Reference arrays
description: Guarde uma lista ordenada de registros de outra entidade, atualize-a com add e remove e filtre por ela.
sidebar:
  order: 21
---

Um campo tipado como lista de outra entidade, como `members: User[]` (ou `Array<User>`), é um **reference array**: uma lista ordenada de ids de registros dessa entidade. Ele tem as mesmas conferências de existência de uma [referência simples](/pt-br/guides/references/), mais regras de lista, operações para adicionar e remover ids, regras de exclusão próprias e filtros próprios.

## Declarando um reference array

```ts check title="entities/User.ts"
export type User = {
  name: string;
};
```

```ts check title="entities/Team.ts"
import type { User } from "./User.ts";

export type Team = {
  name: string;
  /** @maxItems 3 */
  members: User[];
};
```

Nos exemplos desta página, os usuários Ana, Bruno, Carla e Davi têm ids terminados em `…74b4`, `…f4df`, `…9ab2` e `…089e`.

## Ordem e listas vazias

A ordem que você envia é a ordem que volta:

```http
POST /teams
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…9ab2", "01a1…74b4", "01a1…f4df"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…9ab2", "01a1…74b4", "01a1…f4df"],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.508Z"
}
```

Um reference array omitido na criação ou na substituição é guardado como `[]`, mesmo quando o campo não é opcional:

```http
POST /teams
Content-Type: application/json

{
  "name": "Docs"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Docs",
  "members": [],
  "id": "01a1…bf72",
  "createdAt": "2026-10-16T22:35:18.509Z",
  "updatedAt": "2026-10-16T22:35:18.509Z"
}
```

`null` vira `[]` num reference array opcional (`reviewers?: User[]`) e falha com `Cannot be null` num obrigatório como `members`.

## Validação

Cada item precisa ser o id de um registro existente, e o mesmo id não pode aparecer duas vezes. Os erros apontam o item pelo índice.

```http
POST /teams
Content-Type: application/json

{
  "name": "Ops",
  "members": ["01a1…74b4", "01a1…74b4"]
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members[1]",
        "message": "Duplicate item"
      }
    ]
  }
}
```

```http
POST /teams
Content-Type: application/json

{
  "name": "Ops",
  "members": ["01a1…74b4", "01a1…beef"]
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members[1]",
        "message": "Referenced record not found"
      }
    ]
  }
}
```

### Limites com `@minItems` e `@maxItems`

[`@minItems`](/pt-br/reference/tags/#minitems) e [`@maxItems`](/pt-br/reference/tags/#maxitems) limitam o tamanho da lista (`@minLength` e `@maxLength` funcionam como apelidos). `Team.members` aceita no máximo três membros:

```http
POST /teams
Content-Type: application/json

{
  "name": "Ops",
  "members": ["01a1…74b4", "01a1…f4df", "01a1…9ab2", "01a1…089e"]
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members",
        "message": "Must have at most 3 items"
      }
    ]
  }
}
```

`@unique` e `@index` não valem para reference arrays e fazem o build falhar.

## Atualizando com `add` e `remove`

`PUT` e `PATCH` aceitam a lista completa, que substitui a guardada. `PATCH` também aceita `{ "add": [...], "remove": [...] }`, com qualquer uma das chaves opcional, para o cliente mudar a lista sem enviá-la inteira. Tirando a Carla do Core:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "remove": ["01a1…9ab2"]
  }
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…74b4", "01a1…f4df"],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.510Z"
}
```

Como as operações se combinam:

- `remove` roda antes de `add`.
- Remover um id que não está na lista é ignorado.
- Adicionar um id que já está na lista o mantém onde está.
- Ids novos vão para o fim, na ordem enviada.

Aqui o Davi entra no fim, a Ana continua em primeiro, e remover a Carla de novo não muda nada:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "add": ["01a1…089e", "01a1…74b4"],
    "remove": ["01a1…9ab2"]
  }
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…74b4", "01a1…f4df", "01a1…089e"],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.511Z"
}
```

As mesmas conferências valem para a lista resultante, então adicionar um quarto membro viola `@maxItems 3`:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "add": ["01a1…9ab2"]
  }
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members",
        "message": "Must have at most 3 items"
      }
    ]
  }
}
```

O mesmo id em `add` e `remove` é um conflito:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "add": ["01a1…74b4"],
    "remove": ["01a1…74b4"]
  }
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members",
        "message": "Conflicting operations"
      }
    ]
  }
}
```

Qualquer outra chave é recusada:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": {
    "move": ["01a1…74b4"]
  }
}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      {
        "field": "members.move",
        "message": "Unknown field"
      }
    ]
  }
}
```

Para reordenar, envie a lista completa:

```http
PATCH /teams/01a1…9ade
Content-Type: application/json

{
  "members": ["01a1…f4df", "01a1…74b4"]
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": ["01a1…f4df", "01a1…74b4"],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.512Z"
}
```

`add` e `remove` leem a lista atual e gravam o resultado numa só transação, então dois clientes adicionando membros diferentes ao mesmo tempo entram os dois. Qualquer mudança na lista atualiza o `updatedAt` do registro.

`PUT` substitui o registro inteiro, então omitir `members` esvazia a lista:

```http
PUT /teams/01a1…9ade
Content-Type: application/json

{
  "name": "Core"
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": [],
  "id": "01a1…9ade",
  "createdAt": "2026-10-16T22:35:18.508Z",
  "updatedAt": "2026-10-16T22:35:18.513Z"
}
```

No código, `repos.teams.update(id, { members: { add: [userId] } })` aceita as mesmas operações.

## Regras de exclusão

`@onDelete` num reference array decide o que acontece com o dono da lista quando um dos registros listados é apagado:

| Valor | Quando um registro listado é apagado |
| --- | --- |
| `pull` (padrão) | O id sai da lista; os outros itens mantêm a ordem. |
| `restrict` | A exclusão falha com 409 enquanto alguma lista tiver o id. |
| `cascade` | Todo registro cuja lista tem o id é apagado. |

`setNull` não vale para listas e faz o build falhar.

### `pull`

`Team.members` não tem `@onDelete`, então usa `pull`. O Core agora lista Ana, Bruno e Carla, e o Docs lista só o Bruno. Apagando o Bruno:

```http
DELETE /users/01a1…f4df
```

```http
HTTP/1.1 204 No Content
```

```http
GET /teams?fields=name,members
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Ops",
      "members": []
    },
    {
      "name": "Docs",
      "members": []
    },
    {
      "name": "Core",
      "members": ["01a1…74b4", "01a1…9ab2"]
    }
  ],
  "total": 3,
  "limit": 20,
  "offset": 0
}
```

Cada time alterado ganha um `updatedAt` mais novo. O `pull` não confere `@minItems`, então uma lista pode ficar menor que o mínimo.

### `restrict`

```ts check title="entities/Project.ts"
import type { User } from "./User.ts";

export type Project = {
  name: string;
  /** @onDelete restrict */
  reviewers?: User[];
};
```

```http
POST /projects
Content-Type: application/json

{
  "name": "Website",
  "reviewers": ["01a1…9ab2"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Website",
  "reviewers": ["01a1…9ab2"],
  "id": "01a1…9dd7",
  "createdAt": "2026-10-16T22:35:18.513Z",
  "updatedAt": "2026-10-16T22:35:18.513Z"
}
```

Enquanto a Carla revisa o projeto Website, ela não pode ser apagada:

```http
DELETE /users/01a1…9ab2
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by projects"
  }
}
```

### `cascade`

```ts check title="entities/Channel.ts"
import type { User } from "./User.ts";

export type Channel = {
  name: string;
  /** @onDelete cascade */
  owners: User[];
};
```

```http
POST /channels
Content-Type: application/json

{
  "name": "general",
  "owners": ["01a1…089e"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "general",
  "owners": ["01a1…089e"],
  "id": "01a1…bd82",
  "createdAt": "2026-10-16T22:35:18.513Z",
  "updatedAt": "2026-10-16T22:35:18.513Z"
}
```

Apagar o Davi apaga os canais dos quais ele é dono:

```http
DELETE /users/01a1…089e
```

```http
HTTP/1.1 204 No Content
```

```http
GET /channels/01a1…bd82
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": {
    "code": "NOT_FOUND",
    "message": "Channel not found"
  }
}
```

As listas entram no mesmo plano de exclusão das [referências simples](/pt-br/guides/references/#como-uma-exclusão-é-planejada): os `cascade` são seguidos recursivamente, um `restrict` em qualquer ponto do plano bloqueia tudo, e todas as mudanças rodam numa só transação.

## Filtros

Na rota de listagem, reference arrays aceitam operadores próprios:

| Filtro | Encontra registros cuja lista |
| --- | --- |
| `where[members][contains]=<id>` | tem o id |
| `where[members][containsAny]=<id>,<id>` | tem pelo menos um dos ids (até 100) |
| `where[members][containsAll]=<id>,<id>` | tem todos os ids (até 100) |
| `where[members][size][<op>]=<n>` | tem um tamanho que se compara a `n` com `eq`, `ne`, `gt`, `gte`, `lt` ou `lte` |
| `where[members][isEmpty]=true` | está vazia (`false` para não vazia) |

Nestes exemplos, o Core lista Ana, Bruno e Carla, o Docs lista o Bruno, e o Ops está vazio.

```http
GET /teams?where[members][contains]=01a1…74b4&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

```http
GET /teams?where[members][containsAny]=01a1…74b4,01a1…f4df&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Docs"
    },
    {
      "name": "Core"
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

```http
GET /teams?where[members][containsAll]=01a1…74b4,01a1…f4df&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

```http
GET /teams?where[members][size][gte]=2&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

```http
GET /teams?where[members][isEmpty]=true&fields=name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Ops"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

Outros operadores falham com 400, e ordenar por um reference array também:

```http
GET /teams?where[members][gt]=1
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query",
    "details": [
      {
        "field": "where[members][gt]",
        "message": "Operator \"gt\" is not allowed for this field"
      }
    ]
  }
}
```

```http
GET /teams?sort=members
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query",
    "details": [
      {
        "field": "sort",
        "message": "Field \"members\" cannot be sorted"
      }
    ]
  }
}
```

Um reference array escondido da rota de listagem (por exemplo com `@hidden:list`) também não pode ser filtrado.

## Armazenamento e `@joinTable`

No SQLite e no PostgreSQL, cada reference array é guardado numa tabela de junção com o id do dono, o id do alvo e a posição do item, chamada por padrão `<tabela>__<campo em snake_case>` (aqui, `teams__members`). As linhas somem junto com o dono, e ler uma página de registros carrega cada lista com uma única consulta. No MongoDB e em memória, a lista é um array de ids dentro do registro.

[`@joinTable`](/pt-br/reference/tags/#jointable) escolhe outro nome para a tabela de junção:

```ts check title="entities/Organization.ts"
import type { User } from "./User.ts";

export type Organization = {
  name: string;
  /** @joinTable organization_members */
  members: User[];
};
```

- O nome precisa seguir `^[a-z][a-z0-9_]*$` e não pode ser o nome da tabela de uma entidade nem de outra tabela de junção no mesmo schema.
- No MongoDB e em memória, um reference array não tem tabela de junção, então o build ignora a tag e avisa: `entities/Organization.ts: @joinTable on field "members" is ignored on memory (reference arrays are embedded)`.
- Quando só o nome muda, `migration add` gera uma renomeação e mantém os dados.

`@joinTable` também dá nome à tabela compartilhada de uma relação N-N, como em [Relações bidirecionais](/pt-br/guides/relations/#tabelas-de-junção).

## Populando

`?populate=members` devolve os registros listados, em ordem, em vez dos ids. Veja [Populate](/pt-br/guides/populate/#reference-arrays).

## Referência relacionada

- Tags: [`@onDelete`](/pt-br/reference/tags/#ondelete), [`@minItems`](/pt-br/reference/tags/#minitems), [`@maxItems`](/pt-br/reference/tags/#maxitems), [`@joinTable`](/pt-br/reference/tags/#jointable)
- [Operadores de filtro por tipo de campo](/pt-br/reference/http/#operadores-de-filtro-por-tipo-de-campo)
- [`update` do repositório](/pt-br/reference/api/#update)
- [Mensagens de erro](/pt-br/reference/errors/#mensagens)

Próximo: [Relações bidirecionais](/pt-br/guides/relations/).
