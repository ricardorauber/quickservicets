---
title: Sua primeira entidade
description: Descreva um usuário como um tipo TypeScript e suba a API.
sidebar:
  order: 3
---

Uma entidade é um tipo TypeScript em `entities/`. Esta página adiciona um `User` ao projeto `my-api` da [página anterior](/pt-br/getting-started/installation/) e sobe o servidor.

## Escreva a entidade

Crie `examples/my-api/entities/User.ts`:

```ts check title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  /** @maxLength 80 */
  name?: string;
  /** @default 'member' */
  role: "member" | "admin";
};
```

Essa é a entidade inteira. Veja o que cada parte faz:

- **O nome do arquivo e o do tipo são iguais.** Cada arquivo em `entities/` exporta uma entidade, com o nome do arquivo (`User.ts` exporta `User`).
- **As rotas usam o plural.** `User` vira a coleção `users`, servida em `/users`. A tag [`@collection`](/pt-br/reference/tags/#collection) escolhe outro nome.
- **`email`** é obrigatório. `@unique` recusa um segundo usuário com o mesmo email, e `@format email` confere o formato.
- **`name?`** é opcional, e `@maxLength 80` limita o tamanho. Quando não tem valor, as respostas mostram `null`.
- **`role`** só aceita `"member"` ou `"admin"`. `@default 'member'` preenche o campo quando a requisição não o envia.

Você nunca declara `id`, `createdAt` ou `updatedAt`. Toda entidade já os tem: o `id` é um UUID v7, `createdAt` é definido quando o registro é criado, e `updatedAt` a cada mudança.

Todas as tags estão na [referência de tags JSDoc](/pt-br/reference/tags/).

## Suba o servidor

```bash
cd examples/my-api
bun run dev
```

```text
$ quickservice dev
quickservice listening on http://localhost:3000
```

O `dev` gera o projeto, sobe o servidor e, a cada arquivo salvo em `entities/`, `endpoints/`, `hooks/` ou na configuração, gera de novo e reinicia. Defina `PORT` para usar outra porta, por exemplo `PORT=4000 bun run dev`. A partir daí, cada requisição registra uma linha JSON neste terminal.

:::tip
Você também pode gerar e subir em dois passos, como faria em produção:

```bash
bun run build
bun run start
```

O `build` mostra `Built 3 entities, 0 custom endpoints and 0 hooks.` A contagem inclui `File` e `Media`, as duas entidades de arquivo que todo projeto tem.
:::

## O que o build gerou

O build escreveu `.generated/`. Entre outras coisas, ali ficam os tipos da sua entidade, que seus endpoints e hooks usam:

```ts check
// De .generated/types.ts
export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  name?: string | null;
  role: "member" | "admin";
};

export type UserCreate = {
  email: string;
  name?: string | null;
  role?: "member" | "admin";
};

export type UserUpdate = {
  email?: string;
  name?: string | null;
  role?: "member" | "admin";
};
```

`UserCreate` deixa `role` opcional porque ele tem um valor padrão, e `UserUpdate` deixa todos os campos opcionais porque uma atualização pode mudar qualquer um deles.

## As rotas que você ganha

| Método | Caminho | Faz |
| --- | --- | --- |
| `GET` | `/users` | Lista usuários, com paginação, filtros e ordenação |
| `GET` | `/users/<id>` | Lê um usuário |
| `POST` | `/users` | Cria um usuário |
| `PATCH` | `/users/<id>` | Muda alguns campos |
| `PUT` | `/users/<id>` | Substitui o usuário inteiro |
| `DELETE` | `/users/<id>` | Apaga o usuário |

Abra [http://localhost:3000/docs](http://localhost:3000/docs) para navegar por elas. A página é montada a partir do documento OpenAPI em `/openapi.json`, que o build gera do mesmo modelo.

## Sobre o banco em memória

O banco em memória guarda tudo no processo do servidor, então os dados somem a cada reinício, inclusive nos reinícios que o `dev` faz quando você salva um arquivo.

Ele também não precisa de migrações. `bun run migrate` apenas mostra `Nothing to migrate: the memory adapter keeps no schema`. Com SQLite, PostgreSQL ou MongoDB, você cria e aplica migrações com os [comandos `migration add` e `migrate`](/pt-br/reference/cli/).

## Próximo

[Suas primeiras requisições](/pt-br/getting-started/first-requests/): crie, liste, leia, atualize e apague usuários com `curl`.
