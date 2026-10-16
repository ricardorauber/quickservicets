---
title: Visão geral do tutorial
description: O que o tutorial constrói, seu modelo de dados e o que você precisa antes de começar.
sidebar:
  order: 1
---

Neste tutorial você constrói, passo a passo, um serviço de identidade: usuários que pertencem a organizações, times dentro dessas organizações e permissões que definem o que cada usuário pode fazer. O projeto pronto é a pasta `examples/identity` do repositório do quickservice, então você pode comparar seus arquivos com ela a qualquer momento.

## O que você vai construir

- **Módulos** são as partes do seu produto que uma organização pode usar, como `billing` ou `reports`.
- **Permissões** combinam um módulo com uma ação: `manage` ou `view`.
- **Perfis** agrupam permissões sob um nome, como `finance`.
- **Organizações** habilitam módulos e têm membros.
- **Usuários** entram em organizações por meio de **vínculos** (memberships), que carregam perfis.
- **Times** agrupam usuários dentro de uma organização e também carregam perfis.

A primeira parte do tutorial (estas páginas) constrói o modelo e o executa no PostgreSQL. A segunda parte adiciona um endpoint próprio que responde "este usuário tem estas permissões?", explora a documentação da API e escreve testes.

## O modelo de dados

Toda entidade também ganha `id`, `createdAt` e `updatedAt` automaticamente.

| Entidade | Campos | Aponta para |
| --- | --- | --- |
| `Module` | `slug`, `active` | — |
| `Permission` | `module`, `action` (`manage` ou `view`) | um `Module` |
| `Profile` | `slug`, `permissions` | vários `Permission` |
| `Organization` | `slug`, `legalName`, `name?`, `logo?`, `active`, `modules`, `members` | vários `Module`, vários `Membership` |
| `Membership` | `organization`, `user`, `profiles`, `active` | um `Organization`, um `User`, vários `Profile` |
| `Team` | `organization`, `name`, `picture?`, `users`, `profiles`, `active` | um `Organization`, vários `User`, vários `Profile` |
| `User` | `email`, `name?`, `picture?`, `role` (`admin` ou `basic`), `memberships`, `teams` | vários `Membership`, vários `Team` |

Três pares de campos descrevem a mesma relação pelos dois lados, e o quickservice mantém os dois lados sincronizados:

- `Membership.user` e `User.memberships`: cada vínculo tem um usuário, e um usuário tem vários vínculos (1-N).
- `Membership.organization` e `Organization.members`: cada vínculo tem uma organização, e uma organização tem vários membros (1-N).
- `Team.users` e `User.teams`: um time tem vários usuários, e um usuário está em vários times (N-N).

## Antes de começar

- Uma versão recente do [Bun](https://bun.sh).
- Um clone do repositório do quickservice. Os pacotes ainda não estão no npm, então seu projeto fica dentro do repositório, em `examples/`.
- A página [Primeiros passos](/pt-br/getting-started/), se você ainda não a leu.
- Docker, ou qualquer servidor PostgreSQL, para a última página desta parte.

## Crie o projeto

Na raiz do repositório, crie um projeto que guarda os dados em memória. Ele não precisa de servidor de banco de dados, o que facilita experimentar; você o leva para o PostgreSQL no fim desta parte.

```bash
bun packages/cli/src/index.ts init examples/my-identity --db memory
cd examples/my-identity
bun run dev
```

Dentro do repositório, o `init` vincula os pacotes do workspace e os instala para você. O servidor de desenvolvimento escuta em `http://localhost:3000` e reinicia sempre que uma entidade muda. A [referência da CLI](/pt-br/reference/cli/) lista todos os comandos.

:::note
`examples/identity` já contém o projeto pronto, então escolha outro nome de pasta, como `examples/my-identity`.
:::

## Próximo passo

Comece pelas duas primeiras entidades: [Módulos e permissões](/pt-br/tutorial/modules-and-permissions/).
