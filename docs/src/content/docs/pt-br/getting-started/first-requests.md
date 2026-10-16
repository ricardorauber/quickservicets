---
title: Suas primeiras requisições
description: Crie, liste, leia, atualize e apague registros com curl.
sidebar:
  order: 4
---

Com o `bun run dev` da [página anterior](/pt-br/getting-started/first-entity/) rodando, a API responde em `http://localhost:3000`. Abra um segundo terminal e experimente cada rota.

Os ids e as datas abaixo estão encurtados com `…`; os seus serão diferentes.

## Criar

Envie os campos em JSON para `POST /users`:

```bash
curl -X POST localhost:3000/users \
  -H "content-type: application/json" \
  -d '{"email":"ana@example.com","name":"Ana"}'
```

A resposta é `201 Created` com o novo registro. `role` recebeu o valor padrão, e os campos de sistema foram adicionados:

```json
{
  "email": "ana@example.com",
  "name": "Ana",
  "role": "member",
  "id": "01a146d2-1b32-708e-…",
  "createdAt": "2026-10-16T22:25:37.075Z",
  "updatedAt": "2026-10-16T22:25:37.075Z"
}
```

Crie um segundo usuário para ter o que filtrar:

```bash
curl -X POST localhost:3000/users \
  -H "content-type: application/json" \
  -d '{"email":"bruno@example.com","role":"admin"}'
```

```json
{
  "email": "bruno@example.com",
  "role": "admin",
  "id": "01a146d2-1b5a-74d9-…",
  "createdAt": "2026-10-16T22:25:37.114Z",
  "updatedAt": "2026-10-16T22:25:37.114Z",
  "name": null
}
```

Copie o `id` da Ana: os próximos passos o usam no lugar de `<id>`.

## Quando o corpo está errado

As regras da entidade são checadas em toda escrita. Um corpo inválido retorna `400`, com um item por problema:

```bash
curl -X POST localhost:3000/users \
  -H "content-type: application/json" \
  -d '{"email":"not-an-email","role":"owner","age":30}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid body",
    "details": [
      { "field": "email", "message": "Must be a valid email" },
      { "field": "role", "message": "Must be one of: member, admin" },
      { "field": "age", "message": "Unknown field" }
    ]
  }
}
```

Como `email` é `@unique`, repetir um email retorna `409 Conflict`:

```bash
curl -X POST localhost:3000/users \
  -H "content-type: application/json" \
  -d '{"email":"ana@example.com"}'
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

Todo erro tem esse mesmo formato. A [referência de erros](/pt-br/reference/errors/) lista cada código e mensagem.

## Listar

```bash
curl localhost:3000/users
```

`200 OK` com uma página de registros, do mais novo para o mais antigo, e os valores de paginação:

```json
{
  "data": [
    {
      "id": "01a146d2-1b5a-74d9-…",
      "createdAt": "2026-10-16T22:25:37.114Z",
      "updatedAt": "2026-10-16T22:25:37.114Z",
      "email": "bruno@example.com",
      "name": null,
      "role": "admin"
    },
    {
      "id": "01a146d2-1b32-708e-…",
      "createdAt": "2026-10-16T22:25:37.075Z",
      "updatedAt": "2026-10-16T22:25:37.075Z",
      "email": "ana@example.com",
      "name": "Ana",
      "role": "member"
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

`total` conta todos os registros que atendem à consulta, não só os desta página. Use `limit` e `offset` para navegar pelas páginas:

```bash
curl "localhost:3000/users?limit=1&offset=1"
```

```json
{
  "data": [
    {
      "id": "01a146d2-1b32-708e-…",
      "createdAt": "2026-10-16T22:25:37.075Z",
      "updatedAt": "2026-10-16T22:25:37.075Z",
      "email": "ana@example.com",
      "name": "Ana",
      "role": "member"
    }
  ],
  "total": 2,
  "limit": 1,
  "offset": 1
}
```

### Filtrar, ordenar e escolher campos

Os filtros usam `where[<campo>][<op>]=<valor>`. Esta requisição mantém só os admins, ordena por email e retorna apenas dois campos:

```bash
curl -g "localhost:3000/users?where[role][eq]=admin&sort=email&fields=email,role"
```

```json
{
  "data": [{ "email": "bruno@example.com", "role": "admin" }],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

:::caution
O `curl` interpreta colchetes na URL como um padrão e falha com `bad range in URL`. A flag `-g` desliga isso. Navegadores e clientes HTTP não precisam de flag nenhuma.
:::

A [referência de parâmetros de query HTTP](/pt-br/reference/http/) lista todos os parâmetros e os operadores que cada tipo de campo aceita.

## Ler

```bash
curl localhost:3000/users/<id>
```

`200 OK` com o registro:

```json
{
  "id": "01a146d2-1b32-708e-…",
  "createdAt": "2026-10-16T22:25:37.075Z",
  "updatedAt": "2026-10-16T22:25:37.075Z",
  "email": "ana@example.com",
  "name": "Ana",
  "role": "member"
}
```

`fields` também funciona aqui:

```bash
curl "localhost:3000/users/<id>?fields=email,name"
```

```json
{ "email": "ana@example.com", "name": "Ana" }
```

## Atualizar

`PATCH` muda só os campos que você envia:

```bash
curl -X PATCH localhost:3000/users/<id> \
  -H "content-type: application/json" \
  -d '{"name":"Ana Souza"}'
```

`200 OK` com o registro atualizado. O `updatedAt` avançou:

```json
{
  "email": "ana@example.com",
  "name": "Ana Souza",
  "role": "member",
  "id": "01a146d2-1b32-708e-…",
  "createdAt": "2026-10-16T22:25:37.075Z",
  "updatedAt": "2026-10-16T22:25:48.383Z"
}
```

`PUT`, por outro lado, substitui o registro inteiro. Ele exige todos os campos obrigatórios, inclusive `role`, e os campos opcionais que você não enviar viram `null`:

```bash
curl -X PUT localhost:3000/users/<id> \
  -H "content-type: application/json" \
  -d '{"email":"ana@example.com","role":"admin"}'
```

```json
{
  "email": "ana@example.com",
  "name": null,
  "role": "admin",
  "id": "01a146d2-1b32-708e-…",
  "createdAt": "2026-10-16T22:25:37.075Z",
  "updatedAt": "2026-10-16T22:25:48.402Z"
}
```

## Apagar

```bash
curl -i -X DELETE localhost:3000/users/<id>
```

A resposta é `204 No Content`, sem corpo:

```text
HTTP/1.1 204 No Content
```

Ler o usuário de novo agora retorna `404`:

```bash
curl localhost:3000/users/<id>
```

```json
{ "error": { "code": "NOT_FOUND", "message": "User not found" } }
```

## Próximo

[Estrutura do projeto](/pt-br/getting-started/project-structure/): para que serve cada arquivo e pasta de um projeto.
