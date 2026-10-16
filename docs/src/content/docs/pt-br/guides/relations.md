---
title: Relações bidirecionais
description: Junte campos de duas entidades numa só relação (1-1, 1-N ou N-N), guardada uma vez e gravável dos dois lados.
sidebar:
  order: 22
---

Quando duas entidades apontam uma para a outra, como `Book.author` e `Author.books`, o quickservice junta os dois campos numa só **relação**. A relação é guardada uma vez, os dois campos a mostram, e os clientes podem gravá-la de qualquer um dos lados.

## Pareamento

Dois campos formam um par automaticamente quando a entidade X tem exatamente um campo de referência (simples ou array) para Y, e Y tem exatamente um de volta para X. Não é preciso mais nada:

```ts check title="entities/Author.ts"
import type { Book } from "./Book.ts";

export type Author = {
  name: string;
  books: Book[];
};
```

```ts check title="entities/Book.ts"
import type { Author } from "./Author.ts";

export type Book = {
  title: string;
  author: Author;
};
```

Um campo sem nenhum campo apontando de volta, como `User.organization` sozinho, continua sendo uma [referência](/pt-br/guides/references/) comum.

### Pareamento com `@inverse`

Com mais de um candidato de um lado, o pareamento fica ambíguo e o build falha. Se `Book` também tivesse `editor?: Author`:

```ts
// entities/Author.ts: ambiguous relation between Author.books, Book.author, Book.editor;
// add @inverse to pair them (or @inverse none)
export type Book = {
  title: string;
  author: Author;
  editor?: Author;
};
```

[`@inverse`](/pt-br/reference/tags/#inverse) indica o campo com o qual parear. Neste exemplo, uma revista tem um `publisher` e um `printer`, ambos editoras; `@inverse publisher` pareia `magazines` com `publisher`, e `printer` continua uma referência comum:

```ts check title="entities/Publisher.ts"
import type { Magazine } from "./Magazine.ts";

export type Publisher = {
  name: string;
  /** @inverse publisher */
  magazines: Magazine[];
};
```

```ts check title="entities/Magazine.ts"
import type { Publisher } from "./Publisher.ts";

export type Magazine = {
  title: string;
  publisher: Publisher;
  /** @onDelete setNull */
  printer?: Publisher;
};
```

- `@inverse` pode ficar em qualquer um dos lados. Se os dois lados usarem, um precisa indicar o outro, senão o build falha.
- `@inverse none` mantém um campo sem par mesmo quando ele seria pareado automaticamente.

## Tipos de relação

O tipo vem dos tipos dos dois campos:

| Tipo | Campos | Exemplo |
| --- | --- | --- |
| 1-1 | simples + simples | `User.badge` e `Badge.holder` |
| 1-N | simples + array | `Book.author` e `Author.books` |
| N-N | array + array | `Student.courses` e `Course.students` |

Um campo simples opcional significa "zero ou um" daquele lado; um obrigatório significa "exatamente um".

### Lado que guarda e lado derivado

Cada relação é guardada num só lugar, e o outro lado é **derivado**, calculado na leitura:

- **1-N:** o campo simples é uma chave estrangeira (`Book.author`); o array (`Author.books`) não tem coluna e lista os registros relacionados por `createdAt` e depois `id`.
- **1-1:** o campo com [`@owner`](/pt-br/reference/tags/#owner) guarda uma chave estrangeira única. Sem `@owner`, quem guarda é o campo da entidade cujo nome vem primeiro em ordem alfabética. `@owner` nos dois lados faz o build falhar.
- **N-N:** uma [tabela de junção](#tabelas-de-junção) compartilhada guarda as ligações, com uma posição por lado, então cada lado mantém sua própria ordem. Nenhuma das entidades ganha coluna.

Lados derivados se comportam como campos guardados: aparecem como ids nas respostas, aceitam os mesmos filtros, podem ser [populados](/pt-br/guides/populate/) e selecionados com `fields`, e têm os mesmos tipos e schema OpenAPI. Tags de armazenamento como `@unique` ou `@index` num lado derivado fazem o build falhar.

### Regras de exclusão por lado

Cada lado mantém seu próprio [`@onDelete`](/pt-br/reference/tags/#ondelete), aplicado quando o registro para o qual ele aponta é apagado. `Book.author` decide o que acontece com os livros quando um autor é apagado; `Author.books` decide o que acontece com um autor quando um dos livros dele é apagado. As regras são as de [referências](/pt-br/guides/references/#regras-de-exclusão) e de [reference arrays](/pt-br/guides/reference-arrays/#regras-de-exclusão).

## 1-N: um autor, vários livros

Com as entidades `Author` e `Book` acima, crie um livro com seu autor:

```http
POST /books
Content-Type: application/json

{
  "title": "The Dispossessed",
  "author": "01a1…0a5d"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "title": "The Dispossessed",
  "author": "01a1…0a5d",
  "id": "01a1…cdbf",
  "createdAt": "2026-10-16T22:38:13.877Z",
  "updatedAt": "2026-10-16T22:38:13.877Z"
}
```

Depois de um segundo livro, "Mort" (`01a1…bbf8`), o autor lista os dois, na ordem de criação:

```http
GET /authors/01a1…0a5d
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…0a5d",
  "createdAt": "2026-10-16T22:38:13.876Z",
  "updatedAt": "2026-10-16T22:38:13.876Z",
  "name": "Ursula",
  "books": ["01a1…cdbf", "01a1…bbf8"]
}
```

### Gravando pelo lado derivado

Gravar `Author.books` define o `author` de cada livro listado. Adicionar "Mort" a outro autor move o livro:

```http
PATCH /authors/01a1…d75a
Content-Type: application/json

{
  "books": {
    "add": ["01a1…bbf8"]
  }
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Terry",
  "id": "01a1…d75a",
  "createdAt": "2026-10-16T22:38:13.877Z",
  "updatedAt": "2026-10-16T22:38:13.878Z",
  "books": ["01a1…bbf8"]
}
```

```http
GET /books/01a1…bbf8?fields=title,author
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "title": "Mort",
  "author": "01a1…d75a"
}
```

Livros tirados da lista perdem o autor: `author` vira `null` quando é opcional. Aqui ele é obrigatório, então desfazer a ligação falha:

```http
PATCH /authors/01a1…0a5d
Content-Type: application/json

{
  "books": []
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
        "field": "books",
        "message": "Cannot unlink: author is required"
      }
    ]
  }
}
```

O array derivado aceita os [filtros de reference arrays](/pt-br/guides/reference-arrays/#filtros):

```http
GET /authors?where[books][isEmpty]=false&fields=name,books
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "name": "Terry",
      "books": ["01a1…bbf8"]
    },
    {
      "name": "Ursula",
      "books": ["01a1…cdbf"]
    }
  ],
  "total": 2,
  "limit": 20,
  "offset": 0
}
```

`Book.author` usa o padrão `restrict`, então um autor com livros não pode ser apagado:

```http
DELETE /authors/01a1…0a5d
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by books"
  }
}
```

### Autorrelações

Uma relação de uma entidade consigo mesma só é pareada com `@inverse`:

```ts check title="entities/Employee.ts"
export type Employee = {
  name: string;
  /** @onDelete setNull */
  manager?: Employee;
  /** @inverse manager */
  reports: Employee[];
};
```

Com Rui e Lia criados com a Marta como `manager`, o `reports` da Marta lista os dois:

```http
GET /employees/01a1…2f95?fields=name,reports
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Marta",
  "reports": ["01a1…4622", "01a1…1d6a"]
}
```

Um campo que indica a si mesmo em `@inverse` faz o build falhar.

## N-N: alunos e cursos

```ts check title="entities/Student.ts"
import type { Course } from "./Course.ts";

export type Student = {
  name: string;
  courses: Course[];
};
```

```ts check title="entities/Course.ts"
import type { Student } from "./Student.ts";

export type Course = {
  title: string;
  students: Student[];
};
```

Algebra é `01a1…af72` e Biology é `01a1…77d4`. A Ana se matricula nos dois:

```http
POST /students
Content-Type: application/json

{
  "name": "Ana",
  "courses": ["01a1…77d4", "01a1…af72"]
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Ana",
  "id": "01a1…c039",
  "createdAt": "2026-10-16T22:38:13.881Z",
  "updatedAt": "2026-10-16T22:38:13.881Z",
  "courses": ["01a1…77d4", "01a1…af72"]
}
```

Gravar qualquer um dos lados muda as ligações compartilhadas, e o outro lado vê a mudança na hora. Adicionando o Bruno pelo curso:

```http
PATCH /courses/01a1…af72
Content-Type: application/json

{
  "students": {
    "add": ["01a1…d671"]
  }
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "title": "Algebra",
  "id": "01a1…af72",
  "createdAt": "2026-10-16T22:38:13.881Z",
  "updatedAt": "2026-10-16T22:38:13.883Z",
  "students": ["01a1…c039", "01a1…d671"]
}
```

```http
GET /students/01a1…d671?fields=name,courses
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Bruno",
  "courses": ["01a1…af72"]
}
```

Cada lado tem sua própria ordem. A Ana reordena os cursos dela:

```http
PATCH /students/01a1…c039
Content-Type: application/json

{
  "courses": ["01a1…af72", "01a1…77d4"]
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Ana",
  "id": "01a1…c039",
  "createdAt": "2026-10-16T22:38:13.881Z",
  "updatedAt": "2026-10-16T22:38:13.882Z",
  "courses": ["01a1…af72", "01a1…77d4"]
}
```

…e os alunos de Algebra mantêm a deles:

```http
GET /courses/01a1…af72?fields=title,students
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "title": "Algebra",
  "students": ["01a1…c039", "01a1…d671"]
}
```

`Student.courses` usa o padrão `pull`, então apagar Biology tira o curso da lista da Ana:

```http
DELETE /courses/01a1…77d4
```

```http
HTTP/1.1 204 No Content
```

```http
GET /students/01a1…c039?fields=name,courses
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Ana",
  "courses": ["01a1…af72"]
}
```

## 1-1: usuários e crachás

Cada crachá tem no máximo um portador, e cada usuário no máximo um crachá. `@owner` faz de `User.badge` o lado que guarda (sem ele, `Badge.holder` guardaria a relação, porque `Badge` vem primeiro em ordem alfabética):

```ts check title="entities/User.ts"
import type { Badge } from "./Badge.ts";

export type User = {
  name: string;
  /** @owner @onConflict replace */
  badge?: Badge;
};
```

```ts check title="entities/Badge.ts"
import type { User } from "./User.ts";

export type Badge = {
  code: string;
  holder?: User;
};
```

A Ana pega o crachá GOLD (`01a1…101e`):

```http
POST /users
Content-Type: application/json

{
  "name": "Ana",
  "badge": "01a1…101e"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Ana",
  "badge": "01a1…101e",
  "id": "01a1…0770",
  "createdAt": "2026-10-16T22:38:13.883Z",
  "updatedAt": "2026-10-16T22:38:13.883Z"
}
```

```http
GET /badges/01a1…101e?fields=code,holder
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "code": "GOLD",
  "holder": "01a1…0770"
}
```

### Conflitos e `@onConflict replace`

Ligar um registro que já está ligado a outro falha com 409 `Value already exists`. Com [`@onConflict replace`](/pt-br/reference/tags/#onconflict) no campo que você grava, a ligação se move, e o campo do portador anterior vira `null` (um campo obrigatório falha com 409). `User.badge` tem essa tag, então o Bruno pode pegar o GOLD da Ana:

```http
POST /users
Content-Type: application/json

{
  "name": "Bruno",
  "badge": "01a1…101e"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Bruno",
  "badge": "01a1…101e",
  "id": "01a1…dc09",
  "createdAt": "2026-10-16T22:38:13.883Z",
  "updatedAt": "2026-10-16T22:38:13.883Z"
}
```

```http
GET /users/01a1…0770?fields=name,badge
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "name": "Ana",
  "badge": null
}
```

`Badge.holder` não tem `@onConflict`, então dar o crachá SILVER (`01a1…ea2d`) ao Bruno, que já tem o GOLD, falha:

```http
PATCH /badges/01a1…ea2d
Content-Type: application/json

{
  "holder": "01a1…dc09"
}
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "code": "CONFLICT",
    "message": "Value already exists",
    "details": [
      {
        "field": "holder",
        "message": "Value already exists"
      }
    ]
  }
}
```

A Ana está livre agora, então pode recebê-lo pelo lado do crachá:

```http
PATCH /badges/01a1…ea2d
Content-Type: application/json

{
  "holder": "01a1…0770"
}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "code": "SILVER",
  "id": "01a1…ea2d",
  "createdAt": "2026-10-16T22:38:13.883Z",
  "updatedAt": "2026-10-16T22:38:13.885Z",
  "holder": "01a1…0770"
}
```

## Consistência

Uma gravação por qualquer lado roda numa só transação com a gravação principal e atualiza o `updatedAt` de todo registro cujo valor de relação mudou. Se algo falhar, a requisição inteira é desfeita. É por isso que, no MongoDB, o servidor precisa rodar como replica set.

## Tabelas de junção

Uma relação N-N é guardada numa tabela de junção (uma coleção de junção no MongoDB e em memória) chamada `<tabela>__<campo em snake_case>` a partir da entidade cujo nome vem primeiro em ordem alfabética: `courses__students` no exemplo acima. [`@joinTable`](/pt-br/reference/tags/#jointable) em qualquer um dos lados escolhe outro nome:

```ts check title="entities/Team.ts"
import type { Player } from "./Player.ts";

export type Team = {
  name: string;
  /** @joinTable rosters */
  players: Player[];
};
```

```ts check title="entities/Player.ts"
import type { Team } from "./Team.ts";

export type Player = {
  name: string;
  teams: Team[];
};
```

- Os dois lados podem declarar `@joinTable`, mas só com o mesmo nome. Nomes diferentes fazem o build falhar: `Course.students and Student.courses declare different @joinTable names (attendees and enrollments)`.
- Relações 1-1 e 1-N não têm tabela de junção, então `@joinTable` nelas faz o build falhar.
- O nome precisa seguir `^[a-z][a-z0-9_]*$` e não pode colidir com a tabela de uma entidade nem com outra tabela de junção no mesmo schema.
- Quando só o nome muda, `migration add` gera uma renomeação e mantém as ligações.

## Referência relacionada

- Tags: [`@inverse`](/pt-br/reference/tags/#inverse), [`@owner`](/pt-br/reference/tags/#owner), [`@onConflict`](/pt-br/reference/tags/#onconflict), [`@joinTable`](/pt-br/reference/tags/#jointable), [`@onDelete`](/pt-br/reference/tags/#ondelete)
- [Operadores de filtro por tipo de campo](/pt-br/reference/http/#operadores-de-filtro-por-tipo-de-campo)
- [Mensagens de erro](/pt-br/reference/errors/#mensagens)

Próximo: [Populate](/pt-br/guides/populate/).
