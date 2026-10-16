---
title: Entidades e tags
description: Modele seus dados como tipos TypeScript em entities/ e configure-os com tags JSDoc.
sidebar:
  order: 10
---

Uma entidade é um tipo TypeScript na pasta `entities/`. A partir de cada uma, o quickservice gera uma tabela (ou coleção) no banco, rotas CRUD, validação do corpo, um repositório tipado, migrações e a documentação da API. Tags JSDoc no tipo e nos campos ajustam tudo isso.

## Arquivos de entidade

Cada entidade fica no seu próprio arquivo, com o nome do tipo:

```ts check title="entities/Category.ts"
/** @collection product-categories */
export type Category = {
  name: string;
};
```

```ts check title="entities/Product.ts"
import type { Category } from "./Category";

export type Product = {
  name: string;
  price: number;
  inStock: boolean;
  releasedAt?: Date;
  size: "small" | "medium" | "large";
  tags: string[];
  dimensions: { width: number; height: number; unit?: string };
  category?: Category;
};
```

As regras são poucas:

- O nome do arquivo é PascalCase (`Product.ts`, `BlogPost.ts`), e o arquivo exporta exatamente um tipo com o mesmo nome.
- O tipo é um tipo de objeto: `export type Product = { ... }` ou `export interface Product { ... }` geram a mesma entidade.
- Uma pasta dentro de `entities/` é um [schema do banco](#schema): `entities/auth/Account.ts` pertence ao schema `auth`. As pastas têm um nível só.
- Um arquivo que exporta apenas enums ou uniões de strings, como `entities/enums.ts`, não é uma entidade. Ele guarda tipos compartilhados pelas entidades, e o nome dele não precisa ser PascalCase. Veja [Enums e aliases de união](/pt-br/guides/enums/).

O nome da entidade define todos os outros nomes. A coleção é o plural em kebab-case do nome do tipo, e ela dá nome às rotas e ao repositório:

| Arquivo | Rotas | Repositório | Tabela |
| --- | --- | --- | --- |
| `entities/Product.ts` | `/products` | `repos.products` | `products` |
| `entities/BlogPost.ts` | `/blog-posts` | `repos.blogPosts` | `blog_posts` |
| `entities/Box.ts` | `/boxes` | `repos.boxes` | `boxes` |
| `entities/auth/Account.ts` | `/auth/accounts` | `repos.auth.accounts` | `accounts` no schema `auth` |

Quando um arquivo quebra uma regra, o build para e aponta o arquivo:

```text
entities/post.ts: entity file names must be PascalCase (e.g. User.ts)
entities/Post.ts: exported type Article must be named Post
entities/a/b: entities may only be nested one folder deep
```

## Tipos de campo

| Tipo TypeScript | Em JSON | Observações |
| --- | --- | --- |
| `string` | string | |
| `number` | número | `NaN` e valores infinitos são rejeitados. |
| `boolean` | `true` ou `false` | |
| `Date` | string ISO 8601 | Enviada como `"2026-03-01"` ou `"2026-03-01T10:00:00Z"`, devolvida como `"2026-03-01T00:00:00.000Z"`. |
| `"small" \| "medium"`, um `enum` ou um alias de união | um dos valores | Veja [Enums e aliases de união](/pt-br/guides/enums/). |
| `T[]` ou `Array<T>` | array | Itens de qualquer tipo acima, inclusive objetos. |
| `{ width: number; ... }` | objeto | Tipos de objeto inline aninham em qualquer profundidade, com propriedades opcionais próprias. |
| Outra entidade, como `Category` | o id do registro | Uma [referência](/pt-br/guides/references/); só em campos de primeiro nível. |
| Um array de entidade, como `User[]` | array de ids | Um [array de referências](/pt-br/guides/references/), gravado como `[]` quando omitido. |
| `File` ou `Media` de `@quickservice/core` | o id do arquivo | Referências às entidades de arquivo embutidas, enviadas com requisições multipart. |

Qualquer outra coisa para o build com o arquivo, o campo e o tipo: `bigint`, `any`, `string | null`, tipos declarados fora de `entities/` (exceto enums e aliases de união compartilhados) e referências dentro de objetos aninhados.

```text
entities/Post.ts: field "n" has unsupported type "bigint"
entities/Post.ts: field "n" must be a union of string literals only, found "string"
```

### Campos opcionais

Um campo marcado com `?:` é opcional. O corpo pode omiti-lo ou enviar `null` para limpá-lo, e as respostas devolvem `null` quando ele não tem valor. Um campo sem `?:` é obrigatório e nunca aceita `null`. As regras exatas de cada requisição estão em [Validação e mensagens de erro](/pt-br/guides/validation/).

Para aceitar `null`, torne o campo opcional: `nickname?: string`, e não `nickname: string | null`.

## Campos de sistema

Toda entidade ganha três campos que você nunca declara:

- `id`: uma string UUID v7, gerada na criação. O UUID v7 começa com um timestamp, então os ids ficam em ordem de criação.
- `createdAt`: quando o registro foi criado.
- `updatedAt`: quando ele mudou pela última vez.

Eles são somente leitura nos corpos das requisições, e você pode filtrar e ordenar por eles; as listas ordenam por `-createdAt` por padrão. Declarar um deles numa entidade para o build:

```text
entities/Post.ts: field "id" is a system field added to every entity and cannot be declared
```

Com as duas entidades acima, criar uma categoria e um produto fica assim:

```bash
curl -X POST localhost:3000/product-categories -d '{"name":"Shoes"}'
```

```json
{
  "name": "Shoes",
  "id": "01a146d1-20bc-7420-95d8-3005f5e564c0",
  "createdAt": "2026-10-16T22:24:32.956Z",
  "updatedAt": "2026-10-16T22:24:32.956Z"
}
```

```bash
curl -X POST localhost:3000/products -d '{
  "name": "Trail runner", "price": 129.9, "inStock": true, "releasedAt": "2026-03-01",
  "size": "medium", "tags": ["outdoor", "running"], "dimensions": { "width": 11, "height": 30 },
  "category": "01a146d1-20bc-7420-95d8-3005f5e564c0"
}'
```

```json
{
  "name": "Trail runner",
  "price": 129.9,
  "inStock": true,
  "releasedAt": "2026-03-01T00:00:00.000Z",
  "size": "medium",
  "tags": ["outdoor", "running"],
  "dimensions": { "width": 11, "height": 30 },
  "category": "01a146d1-20bc-7420-95d8-3005f5e564c0",
  "id": "01a146d1-20bd-716f-88a7-ce8572d4c814",
  "createdAt": "2026-10-16T22:24:32.957Z",
  "updatedAt": "2026-10-16T22:24:32.957Z"
}
```

## Tags de entidade

As tags de entidade ficam no comentário JSDoc logo acima do tipo. Todas estão descritas na [referência de tags JSDoc](/pt-br/reference/tags/).

### `@collection`

[`@collection`](/pt-br/reference/tags/#collection) substitui o nome de coleção derivado, que dá nome às rotas, ao repositório e à tabela. Ele precisa casar com `^[a-z][a-z0-9-]*$`. A entidade `Category` acima usa a tag, então as rotas dela são `/product-categories` e o repositório é `repos.productCategories`.

```ts check title="entities/Person.ts"
/** @collection people */
export type Person = {
  name: string;
};
```

### `@schema`

As entidades podem ficar em schemas nomeados do banco: schemas do PostgreSQL, tabelas `<schema>__<tabela>` no SQLite e bancos separados no MongoDB. Coloque o arquivo numa pasta ou use [`@schema`](/pt-br/reference/tags/#schema), que tem prioridade sobre a pasta:

```ts check title="entities/auth/Account.ts"
export type Account = {
  email: string;
};
```

```ts check title="entities/auth/Invoice.ts"
/** @schema billing */
export type Invoice = {
  total: number;
};
```

`Account` fica no schema `auth` e `Invoice` em `billing`. O schema vira prefixo das rotas e aninha o repositório:

```bash
curl -X POST localhost:3000/auth/accounts -d '{"email":"ana@example.com"}'
```

```json
{
  "email": "ana@example.com",
  "id": "01a146d1-20bd-7171-a561-7d67f8300d9c",
  "createdAt": "2026-10-16T22:24:32.957Z",
  "updatedAt": "2026-10-16T22:24:32.957Z"
}
```

No código, esse repositório é `repos.auth.accounts`. Duas entidades podem ter o mesmo nome em schemas diferentes, como `entities/User.ts` e `entities/auth/User.ts`; o tipo gerado da segunda passa a ser `AuthUser`. Entidades sem schema usam o padrão, que a chave de configuração `schema` ou a variável de ambiente `DATABASE_SCHEMA` definem por implantação (veja a [referência de configuração](/pt-br/reference/config/)).

### `@internal`

[`@internal`](/pt-br/reference/tags/#internal) mantém a tabela e o repositório, mas não cria rotas, para dados que você só usa no código (hooks e endpoints customizados):

```ts check title="entities/AuditLog.ts"
/** @internal */
export type AuditLog = {
  action: string;
};
```

```bash
curl localhost:3000/audit-logs
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Route not found" } }
```

### Outras tags de entidade

Estas são explicadas nos seus próprios guias:

| Tag | O que faz |
| --- | --- |
| [`@fields`](/pt-br/reference/tags/#fields) | Campos que as rotas de listagem e leitura devolvem. Veja [Seleção de campos e campos ocultos](/pt-br/guides/field-selection/). |
| [`@populate`](/pt-br/reference/tags/#populate) | Referências populadas por padrão na listagem e na leitura. |
| [`@overrideHooks`](/pt-br/reference/tags/#overridehooks) | Se endpoints customizados que substituem uma rota gerada mantêm os hooks da entidade. |
| [`@storage`](/pt-br/reference/tags/#storage) | Storage dos objetos de uma entidade de arquivo. |
| [`@maxSize`](/pt-br/reference/tags/#maxsize) | Maior upload que uma entidade de arquivo aceita. |
| [`@accept`](/pt-br/reference/tags/#accept) | Tipos MIME que uma entidade de arquivo aceita. |
| [`@access`](/pt-br/reference/tags/#access) | Como as URLs de arquivo funcionam: `direct`, `proxy` ou `signed`. |

Qualquer outra tag de entidade aponta um hook de `hooks/`, opcionalmente limitado a operações e com argumentos: `/** @authorized:create,delete admin */` roda `hooks/authorized.ts` na criação e na exclusão, com o argumento `admin`.

## Tags de campo

As tags de campo ficam num comentário JSDoc acima do campo, e um comentário pode ter várias:

```ts check title="entities/User.ts"
export type User = {
  /** @unique @format email */
  email: string;
  /** @minLength 2 @maxLength 80 */
  name: string;
  /** @min 0 @max 150 */
  age?: number;
  /** @default 'member' @index */
  role: "member" | "admin";
  /** @default [] @maxItems 10 */
  tags: string[];
  /** @hidden */
  passwordHash: string;
};
```

| Tag | Vale para | O que faz |
| --- | --- | --- |
| [`@unique`](/pt-br/reference/tags/#unique) | Campos de primeiro nível que não são arrays nem objetos | Rejeita, com 409, um valor que outro registro já tem. |
| [`@index`](/pt-br/reference/tags/#index) | Campos de primeiro nível que não são arrays nem objetos | Cria um índice no banco para filtros e ordenação mais rápidos. |
| [`@default`](/pt-br/reference/tags/#default) | Qualquer campo | Valor usado quando o corpo da criação omite o campo, escrito como literal JSON ou entre aspas simples (`'member'`, `0`, `true`, `[]`). |
| [`@minLength`](/pt-br/reference/tags/#minlength) | Strings e arrays | Tamanho mínimo de uma string, ou número mínimo de itens. |
| [`@maxLength`](/pt-br/reference/tags/#maxlength) | Strings e arrays | Tamanho máximo de uma string, ou número máximo de itens. |
| [`@minItems`](/pt-br/reference/tags/#minitems) | Arrays e arrays de referências | Número mínimo de itens. |
| [`@maxItems`](/pt-br/reference/tags/#maxitems) | Arrays e arrays de referências | Número máximo de itens. |
| [`@min`](/pt-br/reference/tags/#min) | Números | Menor número aceito. |
| [`@max`](/pt-br/reference/tags/#max) | Números | Maior número aceito. |
| [`@format`](/pt-br/reference/tags/#format) | Strings | Verifica se é um `email` ou uma `url`. |
| [`@hidden`](/pt-br/reference/tags/#hidden) | Qualquer campo | Nunca devolve o campo; `@hidden:list` e `@hidden:read` o escondem só ali. Veja [Seleção de campos e campos ocultos](/pt-br/guides/field-selection/). |
| [`@onDelete`](/pt-br/reference/tags/#ondelete) | Referências e arrays de referências | O que acontece com este registro quando o referenciado é excluído. |
| [`@inverse`](/pt-br/reference/tags/#inverse) | Referências e arrays de referências | Junta o campo a um campo da outra entidade numa só relação. |
| [`@owner`](/pt-br/reference/tags/#owner) | Referências simples numa relação 1-1 | Marca o lado que guarda a referência. |
| [`@joinTable`](/pt-br/reference/tags/#jointable) | Arrays de referências | Dá nome à tabela de junção de um array de referências ou de uma relação N-N. |
| [`@onConflict`](/pt-br/reference/tags/#onconflict) | Referências simples numa relação 1-1 | Com `replace`, move um vínculo 1-1 em vez de falhar com 409. |
| [`@maxSize`](/pt-br/reference/tags/#maxsize-1) | Referências a entidades de arquivo | Maior arquivo que o campo aceita. |
| [`@accept`](/pt-br/reference/tags/#accept-1) | Referências a entidades de arquivo | Tipos MIME que o campo aceita. |
| [`@maxTotalSize`](/pt-br/reference/tags/#maxtotalsize) | Arrays de referências a entidades de arquivo | Maior tamanho total enviado ao campo numa requisição. |
| [`@keepFile`](/pt-br/reference/tags/#keepfile) | Referências a entidades de arquivo | Nunca exclui o arquivo referenciado quando ele é substituído ou o registro é excluído. |

As tags são verificadas no build: uma tag desconhecida, uma tag no tipo de campo errado ou um mínimo maior que o máximo param o build.

```text
entities/Post.ts: field "n" has unknown tag @colour
entities/Post.ts: field "n" has invalid @min: only applies to number fields
```

## O que é gerado

`quickservice build` (que o `dev` também roda) lê `entities/` e gera, para cada entidade que não é `@internal`, seis rotas:

| Método e caminho | Operação | Status de sucesso |
| --- | --- | --- |
| `GET /products` | list | 200 |
| `GET /products/:id` | read | 200 |
| `POST /products` | create | 201 |
| `PUT /products/:id` | replace | 200 |
| `PATCH /products/:id` | update | 200 |
| `DELETE /products/:id` | delete | 204 |

Ele também gera:

- **Validação** de todo corpo de criação, substituição e atualização, a partir dos tipos e das tags dos campos. Veja [Validação e mensagens de erro](/pt-br/guides/validation/).
- **Repositórios** para endpoints e hooks, como `repos.products`, tipados com os tipos de `.generated/types.ts`.
- **Migrações**: `quickservice migration add <nome>` escreve em `migrations/` as mudanças de SQL (ou MongoDB) das entidades, e `quickservice migrate` as aplica. Veja a [referência da CLI](/pt-br/reference/cli/).
- **Documentação da API** em `/openapi.json` e `/docs`.

Para a entidade `User` acima, `.generated/types.ts` contém estes tipos (um trecho; o arquivo real também traz as entidades embutidas `File` e `Media`). `UserCreate` e `UserUpdate` tipam os corpos de `create`/`replace` e de `update`, e o `passwordHash` oculto é opcional em `User` porque as leituras o deixam de fora:

```ts check title=".generated/types.ts"
// Generated by quickservice build. Do not edit.
import type { Many, One, Repository } from "@quickservice/core";

export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  name: string;
  age?: number | null;
  role: "member" | "admin";
  tags: Array<string>;
  passwordHash?: string | null;
};

export type UserCreate = {
  email: string;
  name: string;
  age?: number | null;
  role?: "member" | "admin";
  tags?: Array<string>;
  passwordHash: string;
};

export type UserUpdate = {
  email?: string;
  name?: string;
  age?: number | null;
  role?: "member" | "admin";
  tags?: Array<string>;
  passwordHash?: string;
};

export type UserReferences = Record<never, never>;

export interface GeneratedRepositories {
  users: Repository<User, UserReferences, UserCreate, UserUpdate>;
}

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

As rotas geradas aceitam paginação, ordenação, filtros, seleção de campos e populate; veja a [referência de parâmetros de consulta HTTP](/pt-br/reference/http/). Os métodos do repositório estão na [referência da API do repositório](/pt-br/reference/api/).

**Próximo:** [Enums e aliases de união](/pt-br/guides/enums/)
