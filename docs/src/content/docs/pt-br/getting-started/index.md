---
title: Introdução
description: O que é o quickservice e como ele transforma tipos TypeScript em uma API REST.
sidebar:
  order: 1
---

O quickservice é um framework de backend para o [Bun](https://bun.sh). Você descreve seus dados como tipos TypeScript comuns, e ele gera para eles uma API REST tipada, validada e documentada.

Não há decorators, schemas ou classes para manter em sincronia. O tipo é o modelo.

```ts check title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  name?: string;
  /** @default 'member' */
  role: "member" | "admin";
};
```

Só com esse arquivo você ganha as rotas de listar, ler, criar, atualizar, substituir e apagar em `/users`, com validação, filtros, ordenação, paginação e uma página OpenAPI em `/docs`.

## Como funciona

Um projeto tem três pastas que você escreve e uma que o framework escreve:

1. **`entities/`** guarda um tipo por arquivo. Tags JSDoc como `@unique` ou `@default` adicionam regras.
2. **`endpoints/`** e **`hooks/`** guardam suas próprias rotas e o código que roda antes ou depois delas. As duas são opcionais.
3. **`quickservice build`** lê essas pastas e escreve **`.generated/`**: os modelos, os tipos TypeScript, a tabela de rotas, o documento OpenAPI e uma entrada `server.ts`.
4. **`bun .generated/server.ts`** sobe a API.

Enquanto você trabalha, `quickservice dev` faz os passos 3 e 4 por você, e gera tudo de novo e reinicia a cada arquivo alterado.

## O que você ganha

- **CRUD gerado.** Seis rotas por entidade, com paginação por `limit`/`offset`, `sort`, filtros `where[<campo>][<op>]`, seleção com `fields`/`exclude` e `populate`. Veja [Parâmetros de query HTTP](/pt-br/reference/http/).
- **Validação.** Tipos, campos obrigatórios, enums, tamanhos, intervalos e formatos são checados em toda escrita, com um único [formato de erro](/pt-br/reference/errors/).
- **Relações.** Campos que apontam para outras entidades, arrays de referências e relações de dois lados mantidas em sincronia.
- **Arquivos.** Entidades `File` e `Media` embutidas, uploads multipart, armazenamento local ou compatível com S3, e URLs diretas, via proxy ou assinadas.
- **Endpoints e hooks próprios.** Rotas baseadas em arquivos, como `endpoints/users/[id]/stats/get.ts`, e hooks aplicados com uma tag.
- **Repositórios tipados.** `repos.users.findById(...)` e uma API de consultas fluente, tipados a partir das suas entidades. Veja [Repositórios e consultas](/pt-br/reference/api/).
- **Migrações.** Geradas a partir das mudanças no modelo para SQLite, PostgreSQL e MongoDB.
- **Documentação da API.** Um documento OpenAPI 3.1 em `/openapi.json` e uma página Scalar em `/docs`.
- **Quatro bancos de dados.** Em memória, SQLite, PostgreSQL e MongoDB, escolhidos na [configuração](/pt-br/reference/config/).

Todas as tags estão em [Tags JSDoc](/pt-br/reference/tags/), e todos os comandos em [CLI](/pt-br/reference/cli/).

:::note
Os pacotes ainda não estão publicados no npm. Por enquanto, os projetos ficam dentro do repositório do quickservice, em `examples/`, e usam os pacotes do workspace. A próxima página mostra como.
:::

## Próximo

[Instalação e `init`](/pt-br/getting-started/installation/): crie seu primeiro projeto.
