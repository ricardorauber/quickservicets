---
title: Instalação e init
description: Crie um projeto quickservice com o comando init.
sidebar:
  order: 2
---

O comando `init` cria um projeto vazio, pronto para a sua primeira entidade. Esta página cria um projeto chamado `my-api` que usa o banco em memória, então você não precisa instalar mais nada.

## O que você precisa

- O [Bun](https://bun.sh), que roda o framework, a CLI e o seu projeto.
- Um clone do repositório do quickservice, com as dependências instaladas:

```bash
bun install
```

:::note
Os pacotes ainda não estão no npm, então o seu projeto fica dentro do repositório, em `examples/`. Rode todos os comandos desta página a partir da raiz do repositório.
:::

## Crie um projeto

```bash
bun packages/cli/src/index.ts init examples/my-api --db memory
```

Ele mostra os próximos passos:

```text
Next steps:
  1. Create an entity, e.g. entities/User.ts: export type User = { email: string }
  2. Start the dev server: bun run dev
```

Dentro do repositório, o `init` percebe o workspace. Ele escreve `"workspace:*"` para `@quickservice/core` e `@quickservice/cli` no novo `package.json` e roda `bun install` na raiz do repositório, então os pacotes já ficam ligados.

A pasta de destino precisa estar vazia ou ainda não existir; caso contrário, o `init` para com `Directory is not empty`.

## O que o init cria

```text
examples/my-api/
├── .env                       # configurações do banco (vazio para memory)
├── .gitignore                 # .env e node_modules
├── entities/                  # os tipos das suas entidades
├── endpoints/                 # suas rotas próprias
├── hooks/                     # seus hooks
├── package.json               # dependências e scripts
├── quickservice.config.ts  # a configuração do projeto
└── tsconfig.json
```

As três pastas começam com um arquivo `.gitkeep`. A configuração usa o banco que você escolheu:

```ts check title="quickservice.config.ts"
import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
});
```

[Estrutura do projeto](/pt-br/getting-started/project-structure/) explica cada arquivo em detalhes.

## Escolha um banco de dados

`--db` aceita um de quatro valores. Sem ele, o `init` pede para você escolher.

| `--db` | Adapter | Configurações escritas no `.env` |
| --- | --- | --- |
| `memory` | `memoryAdapter()` | nenhuma |
| `sqlite` | `sqliteAdapter(...)` | `DATABASE_PATH=data.db` |
| `postgres` | `postgresAdapter(...)` | `DATABASE_URL` |
| `mongodb` | `mongodbAdapter(...)` | `DATABASE_URL` e `DATABASE_NAME` |

O banco em memória é o jeito mais rápido de começar: não há nada para rodar e nenhuma migração para aplicar. Os dados somem quando o servidor para, então troque de banco quando o modelo estiver mais estável. O Bun lê o `.env` sozinho quando o servidor sobe.

:::caution
Os valores de `postgres` e `mongodb` no `.env` são apenas exemplos. Troque-os pelas suas próprias configurações de conexão antes de subir o servidor.
:::

## Rode a CLI

Dentro do projeto, a CLI fica disponível como `bun run quickservice <comando>`. O projeto também tem quatro scripts:

| Script | Executa |
| --- | --- |
| `bun run dev` | `quickservice dev`: gera, serve e gera de novo a cada mudança |
| `bun run build` | `quickservice build`: escreve `.generated/` |
| `bun run migrate` | `quickservice migrate`: aplica as migrações pendentes |
| `bun run start` | `bun .generated/server.ts`: sobe o último build |

Todos os comandos e flags estão na [referência da CLI](/pt-br/reference/cli/), e todas as chaves de configuração na [referência de configuração](/pt-br/reference/config/).

## Próximo

[Sua primeira entidade](/pt-br/getting-started/first-entity/): descreva um usuário e suba o servidor.
