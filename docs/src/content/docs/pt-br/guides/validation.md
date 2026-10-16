---
title: Validação e mensagens de erro
description: Como os corpos de criação, substituição e atualização são verificados, e os erros que os clientes recebem.
sidebar:
  order: 12
---

Todo corpo enviado a uma rota de escrita gerada é verificado contra a entidade antes de chegar ao banco. As mesmas verificações rodam quando o seu código chama `create`, `replace` ou `update` num repositório. A validação junta todos os problemas numa só resposta, para o cliente corrigir tudo de uma vez.

Os exemplos desta página usam estas duas entidades:

```ts check title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  /** @minLength 2 @maxLength 40 */
  name: string;
  /** @min 0 @max 150 */
  age?: number;
  /** @default 'member' */
  role: "member" | "admin";
  active?: boolean;
  birthday?: Date;
  /** @format url */
  website?: string;
  /** @maxItems 3 */
  tags: string[];
  address?: { city: string; zip?: string };
};
```

```ts check title="entities/Team.ts"
import type { User } from "./User";

export type Team = {
  name: string;
  /** @maxItems 2 */
  members: User[];
  lead?: User;
};
```

## O corpo do erro

Um corpo que falha na validação recebe uma resposta 400 com o código `VALIDATION_ERROR`, a mensagem `Invalid body` e uma entrada em `details` por problema:

```bash
curl -X POST localhost:3000/users -d '{"email":"ana","nickname":"Ani","id":"123"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "id", "message": "Field is read-only" },
      { "field": "email", "message": "Must be a valid email" },
      { "field": "name", "message": "Is required" },
      { "field": "tags", "message": "Is required" },
      { "field": "nickname", "message": "Unknown field" }
    ]
  }
}
```

- `field` é o caminho do valor: `address.city` dentro de um objeto, `tags[1]` dentro de um array.
- Cada campo recebe no máximo uma mensagem: a da primeira verificação em que falha.
- Os campos de sistema somente leitura vêm primeiro, depois os campos da entidade na ordem de declaração, depois os campos desconhecidos.

Todos os status, códigos e mensagens estão na [referência de erros](/pt-br/reference/errors/).

## Criar, substituir e atualizar

As três rotas de escrita só diferem em quais campos precisam estar presentes:

| Rota | Modo | Campos obrigatórios |
| --- | --- | --- |
| `POST /users` | create | Todo campo obrigatório, exceto os que têm [`@default`](/pt-br/reference/tags/#default) |
| `PUT /users/:id` | replace | Todo campo obrigatório, **inclusive** os que têm `@default` |
| `PATCH /users/:id` | update | Nenhum: os campos ausentes mantêm seus valores |

Em todos os modos, um campo marcado com `?:` pode ser omitido, e um [array de referências](/pt-br/guides/references/) nunca é obrigatório: quando omitido na criação ou na substituição, ele é gravado como `[]`.

Na criação, `@default` preenche o que o corpo omite, e os campos opcionais omitidos voltam como `null`:

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@example.com","name":"Ana","tags":[]}'
```

```json
{
  "email": "ana@example.com",
  "name": "Ana",
  "tags": [],
  "role": "member",
  "id": "01a146d1-db03-70b5-a935-555f0027c6d2",
  "createdAt": "2026-10-16T22:25:20.645Z",
  "updatedAt": "2026-10-16T22:25:20.645Z",
  "age": null,
  "active": null,
  "birthday": null,
  "website": null,
  "address": null
}
```

A substituição envia o registro inteiro, então os padrões não se aplicam e `role` precisa estar lá:

```bash
curl -X PUT localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"email":"ana@example.com","name":"Ana"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "role", "message": "Is required" },
      { "field": "tags", "message": "Is required" }
    ]
  }
}
```

Uma substituição bem-sucedida limpa os campos opcionais que omite. Uma atualização muda só o que envia:

```bash
curl -X PATCH localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"name":"Ana Souza","age":31}'
```

```json
{
  "email": "ana@example.com",
  "name": "Ana Souza",
  "tags": [],
  "role": "member",
  "id": "01a146d1-db03-70b5-a935-555f0027c6d2",
  "createdAt": "2026-10-16T22:25:20.645Z",
  "updatedAt": "2026-10-16T22:25:20.646Z",
  "age": 31,
  "active": null,
  "birthday": null,
  "website": null,
  "address": null
}
```

O array de referências `members` de `Team` é obrigatório no tipo, mas uma criação sem ele funciona:

```bash
curl -X POST localhost:3000/teams -d '{"name":"Core"}'
```

```json
{
  "name": "Core",
  "members": [],
  "id": "01a146d1-db07-7016-8816-640f032c1a33",
  "createdAt": "2026-10-16T22:25:20.647Z",
  "updatedAt": "2026-10-16T22:25:20.647Z",
  "lead": null
}
```

### Objetos aninhados

Um valor de objeto é sempre verificado por inteiro, mesmo numa atualização: enviar `address` substitui o endereço gravado, então as propriedades obrigatórias dele precisam estar lá.

```bash
curl -X PATCH localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"address":{"zip":"01000"}}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "address.city", "message": "Is required" }]
  }
}
```

## Null

- `null` num campo **opcional** o limpa. Num array de referências opcional, grava `[]`.
- `null` num campo **obrigatório**, inclusive um array de referências obrigatório, falha com `Cannot be null`.
- `null` como item de array falha com `Cannot be null` naquele item, como `tags[0]`.

```bash
curl -X PATCH localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"age":null,"name":null}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "name", "message": "Cannot be null" }]
  }
}
```

O mesmo corpo sem `name` funciona e devolve `"age": null`.

## Mensagens de tipo

| Tipo do campo | Mensagem |
| --- | --- |
| `string` | `Must be a string` |
| `number` | `Must be a number` (também para `NaN` e valores infinitos) |
| `boolean` | `Must be a boolean` |
| `Date` | `Must be an ISO 8601 date` |
| enum ou união | `Must be one of: <valores>` |
| array | `Must be an array` |
| objeto | `Must be an object` |
| referência | `Must be a string` (um id não vazio) |
| array de referências | `Must be an array`; cada item `Must be a string`, e `Duplicate item` para um id enviado duas vezes |

Um campo `Date` aceita uma string ISO 8601: uma data (`2026-03-01`) ou data e hora (`2026-03-01T10:00:00Z`, com ou sem segundos e fuso).

```bash
curl -X POST localhost:3000/users -d '{"email":1,"name":true,"age":"30","active":"yes","birthday":"yesterday","role":"root","tags":"a","address":"Rio"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "email", "message": "Must be a string" },
      { "field": "name", "message": "Must be a string" },
      { "field": "age", "message": "Must be a number" },
      { "field": "role", "message": "Must be one of: member, admin" },
      { "field": "active", "message": "Must be a boolean" },
      { "field": "birthday", "message": "Must be an ISO 8601 date" },
      { "field": "tags", "message": "Must be an array" },
      { "field": "address", "message": "Must be an object" }
    ]
  }
}
```

Dentro de arrays e objetos, o caminho aponta o valor exato:

```bash
curl -X POST localhost:3000/users -d '{"email":"bo@example.com","name":"Bo","tags":["a",2],"address":{"city":1,"country":"BR"}}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "tags[1]", "message": "Must be a string" },
      { "field": "address.city", "message": "Must be a string" },
      { "field": "address.country", "message": "Unknown field" }
    ]
  }
}
```

## Mensagens das tags

| Tag | Mensagem |
| --- | --- |
| [`@minLength`](/pt-br/reference/tags/#minlength) numa string | `Must be at least <n> characters` |
| [`@maxLength`](/pt-br/reference/tags/#maxlength) numa string | `Must be at most <n> characters` |
| [`@minItems`](/pt-br/reference/tags/#minitems), ou `@minLength` num array | `Must have at least <n> items` |
| [`@maxItems`](/pt-br/reference/tags/#maxitems), ou `@maxLength` num array | `Must have at most <n> items` |
| [`@min`](/pt-br/reference/tags/#min) | `Must be at least <n>` |
| [`@max`](/pt-br/reference/tags/#max) | `Must be at most <n>` |
| [`@format`](/pt-br/reference/tags/#format) `email` | `Must be a valid email` |
| [`@format`](/pt-br/reference/tags/#format) `url` | `Must be a valid URL` (só `http` e `https`) |

Os limites são inclusivos: com `@min 0`, o valor `0` passa.

```bash
curl -X POST localhost:3000/users -d '{"email":"bo@","name":"B","age":-1,"website":"ftp://x.co","tags":["a","b","c","d"]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "email", "message": "Must be a valid email" },
      { "field": "name", "message": "Must be at least 2 characters" },
      { "field": "age", "message": "Must be at least 0" },
      { "field": "website", "message": "Must be a valid URL" },
      { "field": "tags", "message": "Must have at most 3 items" }
    ]
  }
}
```

## Campos desconhecidos e somente leitura

- Um campo que a entidade não declara falha com `Unknown field`, no primeiro nível e dentro de objetos (`address.country` acima).
- `id`, `createdAt` e `updatedAt` falham com `Field is read-only` em todos os modos. Quem os define é o framework.
- Campos que o framework gerencia, como os metadados das entidades de arquivo, também são somente leitura.

```bash
curl -X PUT localhost:3000/users/01a146d1-db03-70b5-a935-555f0027c6d2 -d '{"email":"ana@example.com","name":"Ana","role":"admin","tags":[],"createdAt":"2020-01-01"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "createdAt", "message": "Field is read-only" }]
  }
}
```

## Corpos que não são objetos

Um corpo que não é JSON válido recebe `Invalid JSON body`, e um valor JSON que não é objeto recebe um detalhe com `field` vazio:

```bash
curl -X POST localhost:3000/users -d '{"email":'
```

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid JSON body" } }
```

```bash
curl -X POST localhost:3000/users -d '[]'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "", "message": "Body must be a JSON object" }]
  }
}
```

## Verificações no banco

Algumas regras precisam dos dados gravados, então rodam depois que o corpo é válido:

- Um campo [`@unique`](/pt-br/reference/tags/#unique) cujo valor outro registro já tem falha com 409 `CONFLICT`.
- Uma referência, ou um item de array de referências, que aponta para um registro inexistente falha com 400 `Referenced record not found`.

```bash
curl -X POST localhost:3000/users -d '{"email":"ana@example.com","name":"Ana Two","tags":[]}'
```

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "Value already exists",
    "details": [{ "field": "email", "message": "Value already exists" }]
  }
}
```

```bash
curl -X POST localhost:3000/teams -d '{"name":"Core","members":["01a146d1-db03-70b5-a935-555f0027c6d2","01a146d1-0000-7000-8000-000000000000"]}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [{ "field": "members[1]", "message": "Referenced record not found" }]
  }
}
```

O mesmo id duas vezes num array de referências falha antes disso, com `Duplicate item` na segunda ocorrência:

```bash
curl -X POST localhost:3000/teams -d '{"name":"Core","members":["01a146d1-db03-70b5-a935-555f0027c6d2","01a146d1-db03-70b5-a935-555f0027c6d2"],"lead":""}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "members[1]", "message": "Duplicate item" },
      { "field": "lead", "message": "Must be a string" }
    ]
  }
}
```

Numa atualização, um array de referências também aceita `{ "add": [...], "remove": [...] }` no lugar da lista completa; veja o [guia de referências](/pt-br/guides/references/).

**Próximo:** [Seleção de campos e campos ocultos](/pt-br/guides/field-selection/)
