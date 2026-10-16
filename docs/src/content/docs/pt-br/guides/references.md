---
title: Referências e regras de exclusão
description: Aponte um campo para um registro de outra entidade e escolha o que acontece quando esse registro é apagado.
sidebar:
  order: 20
---

Um campo tipado com outra entidade é uma **referência**: ele guarda o id de um registro dessa entidade. O quickservice confere se o registro existe a cada escrita e, quando o registro referenciado é apagado, aplica a regra `@onDelete` do campo.

## Declarando uma referência

Importe o tipo da outra entidade e use-o como tipo do campo:

```ts check title="entities/Organization.ts"
export type Organization = {
  name: string;
};
```

```ts check title="entities/User.ts"
import type { Organization } from "./Organization.ts";

export type User = {
  email: string;
  organization: Organization;
};
```

Nas requisições e respostas, `organization` é o id da organização, uma string. Uma referência pode ser opcional (`organization?: Organization`), e aí também aceita `null`. Uma entidade pode referenciar a si mesma, como no [exemplo de autorreferência](#autorreferências) mais abaixo.

Referências só são suportadas em campos de primeiro nível. Um tipo de entidade dentro de um objeto aninhado ou de um array de objetos faz o build falhar:

```ts
// entities/User.ts: field "meta.owner" references an entity, which is only supported in top-level fields
export type User = {
  meta: { owner: Organization };
};
```

Para guardar vários registros, use uma lista do tipo da entidade (`members: User[]`). Isso é um reference array, assunto de [Reference arrays](/pt-br/guides/reference-arrays/).

## Conferência de existência

Criar, atualizar ou substituir um registro confere se cada referência aponta para um registro que existe. Se não existir, a requisição falha com 400, indicando o campo:

```http
POST /users
Content-Type: application/json

{
  "email": "ana@acme.co",
  "organization": "01a1…beef"
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
        "field": "organization",
        "message": "Referenced record not found"
      }
    ]
  }
}
```

Com o id de uma organização que existe, o usuário é criado:

```http
POST /users
Content-Type: application/json

{
  "email": "ana@acme.co",
  "organization": "01a1…e3eb"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "email": "ana@acme.co",
  "organization": "01a1…e3eb",
  "id": "01a1…1e6b",
  "createdAt": "2026-10-16T22:34:07.833Z",
  "updatedAt": "2026-10-16T22:34:07.833Z"
}
```

Campos de referência aceitam os filtros `eq`, `ne`, `in`, `nin`, `exists` e `isNull`, então dá para listar os usuários de uma organização:

```http
GET /users?where[organization][eq]=01a1…e3eb&fields=email
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "email": "ana@acme.co"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

Para receber a própria organização em vez do id, use [populate](/pt-br/guides/populate/).

## Regras de exclusão

`@onDelete` num campo de referência diz o que acontece com **este** registro quando o registro para o qual ele aponta é apagado:

| Valor | Quando o registro referenciado é apagado |
| --- | --- |
| `restrict` (padrão) | A exclusão falha com 409 enquanto este registro apontar para ele. |
| `cascade` | Este registro também é apagado. |
| `setNull` | Este campo vira `null`. Só para campos opcionais. |

Os exemplos abaixo usam as entidades `Organization` e `User` acima, mais um `Post` e um `Comment` que apontam para um usuário.

### `restrict`

`User.organization` não tem `@onDelete`, então usa `restrict`. Enquanto Ana pertencer à Acme, a Acme não pode ser apagada:

```http
DELETE /organizations/01a1…e3eb
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by users"
  }
}
```

A mensagem indica a coleção que bloqueia a exclusão (`Cannot delete: referenced by <collection>`), e nada é apagado. Apague ou mova os usuários antes e depois apague a organização.

### `cascade`

Um post não existe sem seu autor, então apagar o autor apaga o post:

```ts check title="entities/Post.ts"
import type { User } from "./User.ts";

export type Post = {
  title: string;
  /** @onDelete cascade */
  author: User;
};
```

### `setNull`

Um comentário pode continuar existindo sem o autor, então a referência é opcional e vira `null`:

```ts check title="entities/Comment.ts"
import type { User } from "./User.ts";

export type Comment = {
  text: string;
  /** @onDelete setNull */
  author?: User;
};
```

Ana escreveu um post (`01a1…2ae2`) e um comentário (`01a1…5175`). Apagar a Ana aplica as duas regras de uma vez:

```http
DELETE /users/01a1…1e6b
```

```http
HTTP/1.1 204 No Content
```

O post foi apagado junto com ela:

```http
GET /posts/01a1…2ae2
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": {
    "code": "NOT_FOUND",
    "message": "Post not found"
  }
}
```

O comentário continua lá, sem autor, e o `updatedAt` dele avançou:

```http
GET /comments/01a1…5175
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…5175",
  "createdAt": "2026-10-16T22:34:07.834Z",
  "updatedAt": "2026-10-16T22:34:07.835Z",
  "text": "Nice post",
  "author": null
}
```

`setNull` num campo obrigatório, ou qualquer outro valor, faz o build falhar:

```ts
// entities/Comment.ts: field "author" must be optional to use @onDelete setNull
export type Comment = {
  /** @onDelete setNull */
  author: User;
};
```

### Como uma exclusão é planejada

Antes de mudar qualquer coisa, a exclusão reúne todos os registros afetados, seguindo os `cascade` por quantos níveis forem precisos. Se algum desses registros ainda for apontado por uma referência `restrict`, a exclusão inteira falha com 409 e nada muda. Caso contrário, os `cascade`, as atualizações de `setNull` e a própria exclusão rodam numa só transação. Isso funciona igual em todos os bancos.

## Autorreferências

Com uma autorreferência e `cascade`, apagar uma categoria apaga toda a sua subárvore:

```ts check title="entities/Category.ts"
export type Category = {
  name: string;
  /** @onDelete cascade */
  parent?: Category;
};
```

```http
POST /categories
Content-Type: application/json

{
  "name": "Fiction",
  "parent": "01a1…76a0"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Fiction",
  "parent": "01a1…76a0",
  "id": "01a1…1a3b",
  "createdAt": "2026-10-16T22:34:07.835Z",
  "updatedAt": "2026-10-16T22:34:07.835Z"
}
```

Com "Fantasy" criada dentro de "Fiction", apagar "Books" (`01a1…76a0`) remove as três:

```http
DELETE /categories/01a1…76a0
```

```http
HTTP/1.1 204 No Content
```

```http
GET /categories
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [],
  "total": 0,
  "limit": 20,
  "offset": 0
}
```

Ciclos também são tratados: um registro nunca é planejado duas vezes, então a exclusão sempre termina.

:::tip
Quando duas entidades apontam uma para a outra (por exemplo `User.organization` e `Organization.users`), elas formam uma [relação bidirecional](/pt-br/guides/relations/). Cada lado mantém seu próprio `@onDelete`.
:::

## Referência relacionada

- [`@onDelete`](/pt-br/reference/tags/#ondelete) na referência de tags
- [Operadores de filtro por tipo de campo](/pt-br/reference/http/#operadores-de-filtro-por-tipo-de-campo)
- [Mensagens de erro](/pt-br/reference/errors/#mensagens), incluindo `Referenced record not found` e `Cannot delete: referenced by <collection>`

Próximo: [Reference arrays](/pt-br/guides/reference-arrays/).
