---
title: Populate
description: Devolva registros referenciados como objetos em vez de ids, pela query, por tags de entidade, tags de endpoint ou código.
sidebar:
  order: 23
---

Referências e reference arrays voltam como ids. **Popular** um caminho troca esses ids pelos registros referenciados, carregados com uma consulta em lote por caminho, não importa quantos registros a resposta tenha.

Os exemplos desta página usam estas entidades:

```ts check title="entities/Country.ts"
export type Country = {
  name: string;
  code: string;
};
```

```ts check title="entities/Organization.ts"
import type { Country } from "./Country.ts";

export type Organization = {
  name: string;
  country: Country;
};
```

```ts check title="entities/User.ts"
import type { Organization } from "./Organization.ts";

export type User = {
  name: string;
  /** @hidden */
  passwordHash: string;
  organization: Organization;
};
```

```ts check title="entities/Team.ts"
import type { User } from "./User.ts";

/** @populate:read members */
export type Team = {
  name: string;
  members: User[];
};
```

## `?populate=` nas rotas geradas

As rotas de listagem e leitura aceitam `populate`, uma lista de caminhos de referência separados por vírgula. Sem ele, `organization` é um id:

```http
GET /users/01a1…05a8
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…05a8",
  "createdAt": "2026-10-16T22:40:43.795Z",
  "updatedAt": "2026-10-16T22:40:43.795Z",
  "name": "Ana",
  "organization": "01a1…b81a"
}
```

Com ele, a organização é um registro:

```http
GET /users/01a1…05a8?populate=organization
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…05a8",
  "createdAt": "2026-10-16T22:40:43.795Z",
  "updatedAt": "2026-10-16T22:40:43.795Z",
  "name": "Ana",
  "organization": {
    "id": "01a1…b81a",
    "createdAt": "2026-10-16T22:40:43.795Z",
    "updatedAt": "2026-10-16T22:40:43.795Z",
    "name": "Acme",
    "country": "01a1…b1d2"
  }
}
```

Um registro populado mostra o que a entidade dele mostra na própria rota de leitura: campos escondidos ali, e campos `@hidden` como `passwordHash`, nunca aparecem. Quando um registro referenciado não existe mais, uma referência simples vira `null`.

Só leituras são populadas: as respostas de criação, atualização e substituição sempre devolvem ids.

## Caminhos aninhados

Separe os segmentos de um caminho com pontos para ir mais fundo. `organization.country` popula a organização e, dentro dela, o país. A [seleção de campos](/pt-br/guides/field-selection/) consegue então entrar nos registros populados:

```http
GET /users?populate=organization.country&fields=name,organization.country.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Bruno",
      "organization": {
        "country": {
          "name": "Brazil"
        }
      }
    },
    {
      "name": "Ana",
      "organization": {
        "country": {
          "name": "Brazil"
        }
      }
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

`fields` só aceita um caminho dentro de uma referência quando essa referência exata está em `populate`. Para selecionar também campos da própria organização, liste `organization` também:

```http
GET /users?populate=organization,organization.country&fields=name,organization.name,organization.country.code
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Bruno",
      "organization": {
        "name": "Acme",
        "country": {
          "code": "BR"
        }
      }
    },
    {
      "name": "Ana",
      "organization": {
        "name": "Acme",
        "country": {
          "code": "BR"
        }
      }
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

Sem isso, a seleção falha:

```http
GET /users?populate=organization.country&fields=name,organization.name
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
        "field": "fields",
        "message": "Unknown field: organization.name"
      }
    ]
  }
}
```

O mesmo erro volta quando `populate` não é enviado.

Todo segmento de um caminho precisa ser um campo de referência ou de reference array:

```http
GET /users?populate=name
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Cannot populate: name",
    "details": [
      {
        "field": "populate",
        "message": "Cannot populate: name"
      }
    ]
  }
}
```

## `populate.maxDepth`

Um caminho pode ter no máximo `populate.maxDepth` segmentos, 2 por padrão:

```http
GET /teams?populate=members.organization.country
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Populate depth exceeds 2",
    "details": [
      {
        "field": "populate",
        "message": "Populate depth exceeds 2"
      }
    ]
  }
}
```

Aumente o valor na [configuração](/pt-br/reference/config/) quando precisar de caminhos mais fundos. Ele vale igualmente para o parâmetro da query, para as tags e para o código mais abaixo:

```ts check title="quickservice.config.ts"
import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
  populate: { maxDepth: 3 },
});
```

## Reference arrays

Um reference array populado lista os registros na ordem guardada. Ids cujos registros não existem mais ficam de fora, em vez de voltarem como `null`. Caminhos podem passar por arrays (`members.organization`), e a seleção de campos vale para cada item:

```http
GET /teams?populate=members&fields=name,members.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core",
      "members": [
        {
          "name": "Bruno"
        },
        {
          "name": "Ana"
        }
      ]
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

Os lados derivados de [relações bidirecionais](/pt-br/guides/relations/) são populados do mesmo jeito.

## `@populate` na entidade

[`@populate`](/pt-br/reference/tags/#populate) num tipo de entidade popula caminhos por padrão. Restrinja com `:list` ou `:read`, ou deixe sem escopo para valer nos dois. `Team` tem `@populate:read members`, então a rota de leitura popula `members` sem nenhum parâmetro:

```http
GET /teams/01a1…a0ca?fields=name,members.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": [
    {
      "name": "Bruno"
    },
    {
      "name": "Ana"
    }
  ]
}
```

`?populate=` soma caminhos aos da tag:

```http
GET /teams/01a1…a0ca?populate=members.organization&fields=name,members.name,members.organization.name
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Core",
  "members": [
    {
      "name": "Bruno",
      "organization": {
        "name": "Acme"
      }
    },
    {
      "name": "Ana",
      "organization": {
        "name": "Acme"
      }
    }
  ]
}
```

A rota de listagem não é coberta por `:read`, então continua devolvendo ids:

```http
GET /teams?fields=name,members
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Core",
      "members": ["01a1…0f74", "01a1…05a8"]
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

Um caminho inválido ou mais fundo que `populate.maxDepth` na tag faz o build falhar, por exemplo `entities/User.ts: invalid @populate: Cannot populate: email`.

## `@populate` no endpoint

Um [endpoint personalizado](/pt-br/guides/endpoints/) que substitui uma rota gerada de listagem ou leitura pode declarar seu próprio [`@populate`](/pt-br/reference/tags/#populate-1). Ele substitui a tag da entidade nessa rota e vale para o registro, o array ou a página `{ data }` que o handler devolver. Sem ele, o override mantém a tag da entidade.

Os endpoints recebem repositórios tipados a partir dos tipos que o build gera em `.generated/types.ts`. Este trecho mostra as partes usadas nos exemplos abaixo, incluindo os mapas de referências que tipam os registros populados:

```ts check title=".generated/types.ts"
// Generated by quickservice build. Do not edit. (excerpt)
import type { One, Repository } from "@quickservice/core";

export type Country = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  code: string;
};

export type CountryReferences = Record<never, never>;

export type Organization = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  country: string;
};

export type OrganizationReferences = {
  country: One<Country, CountryReferences>;
};

export type User = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  name: string;
  passwordHash?: string | null;
  organization: string;
};

export type UserReferences = {
  organization: One<Organization, OrganizationReferences>;
};

export interface GeneratedRepositories {
  organizations: Repository<Organization, OrganizationReferences>;
  users: Repository<User, UserReferences>;
}

declare module "@quickservice/core" {
  interface Repositories extends GeneratedRepositories {}
}
```

Este endpoint substitui `GET /organizations/:id` e popula `country`:

```ts check title="endpoints/organizations/[id]/get.ts"
import { HttpError, type Endpoint } from "@quickservice/core";

/** @populate country */
const handler: Endpoint = async (repos, req) => {
  const organization = await repos.organizations.findById(req.params.id!);
  if (!organization) throw new HttpError(404, "Organization not found");
  return organization;
};

export default handler;
```

```http
GET /organizations/01a1…b81a
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…b81a",
  "createdAt": "2026-10-16T22:40:43.795Z",
  "updatedAt": "2026-10-16T22:40:43.795Z",
  "name": "Acme",
  "country": {
    "id": "01a1…b1d2",
    "createdAt": "2026-10-16T22:40:43.791Z",
    "updatedAt": "2026-10-16T22:40:43.791Z",
    "name": "Brazil",
    "code": "BR"
  }
}
```

Num endpoint que não substitui uma rota de listagem ou leitura, a tag faz o build falhar: `endpoints/users/[id]/stats/get.ts: @populate is only allowed on endpoints that override a list or read route`.

## Populando no código

### `include(...)` em consultas fluentes

Em endpoints e hooks, [`include(...)`](/pt-br/reference/api/#include) numa consulta fluente popula caminhos em cada registro que ela devolve. O resultado é tipado em todos os níveis, então `user.organization?.country?.code` passa na checagem de tipos, e um caminho que não existe não passa:

```ts check title="endpoints/organizations/[id]/people/get.ts"
import type { Endpoint } from "@quickservice/core";

type Person = { name: string; country: string | null };

/** @summary People of an organization, with their country code */
const handler: Endpoint<unknown, Person[]> = async (repos, req) => {
  const users = await repos.users
    .where((user) => user.organization.eq(req.params.id!))
    .orderBy((user) => user.name)
    .include("organization.country")
    .all();
  return users.map((user) => ({ name: user.name, country: user.organization?.country?.code ?? null }));
};

export default handler;
```

```http
GET /organizations/01a1…b81a/people
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

[
  {
    "name": "Ana",
    "country": "BR"
  },
  {
    "name": "Bruno",
    "country": "BR"
  }
]
```

`include` segue as mesmas regras de `?populate=`, incluindo `populate.maxDepth` e o erro `Populate depth exceeds <n>`.

### A opção `populate`

`findById`, `findOne` e `list` aceitam a opção `populate` com a mesma tipagem, e `findByIds` aceita `include`:

```ts check
import type { Repositories } from "@quickservice/core";

export async function countryOf(repos: Repositories, userId: string): Promise<string | null> {
  const user = await repos.users.findById(userId, { populate: ["organization.country"] });
  return user?.organization?.country?.name ?? null;
}
```

Para registros que você já tem, como o resultado de uma consulta própria, [`populate(records, paths)`](/pt-br/reference/api/#populate) faz o preenchimento.

## Referência relacionada

- [Parâmetros de query HTTP](/pt-br/reference/http/): `populate` e `fields`
- [`@populate` em entidades](/pt-br/reference/tags/#populate) e [em endpoints](/pt-br/reference/tags/#populate-1)
- [`populate.maxDepth`](/pt-br/reference/config/)
- Repositórios: [`include`](/pt-br/reference/api/#include), [`findById`](/pt-br/reference/api/#findbyid), [`findByIds`](/pt-br/reference/api/#findbyids), [`populate`](/pt-br/reference/api/#populate)
- [Mensagens de erro](/pt-br/reference/errors/#mensagens), incluindo `Populate depth exceeds <n>`

Próximo: [Endpoints personalizados e overrides](/pt-br/guides/endpoints/).
