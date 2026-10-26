# Bidirectional relations

> Pair fields of two entities into one relation (1-1, 1-N or N-N), stored once and writable from either side.

When two entities point to each other, like `Book.author` and `Author.books`, QuickService.ts pairs the two fields into one **relation**. The relation is stored once, both fields show it, and clients can write it from either side.

## Pairing

Two fields pair automatically when entity X has exactly one reference field (single or array) to Y, and Y has exactly one back to X. Nothing else is needed:

```ts title="entities/Author.ts"
import type { Book } from "./Book.ts";

export type Author = {
  name: string;
  books: Book[];
};
```

```ts title="entities/Book.ts"
import type { Author } from "./Author.ts";

export type Book = {
  title: string;
  author: Author;
};
```

A field with no field pointing back, like `User.organization` alone, stays a plain [reference](/guides/references/).

### Pairing with `@inverse`

With more than one candidate on a side, pairing is ambiguous and the build fails. If `Book` also had `editor?: Author`:

```ts
// entities/Author.ts: ambiguous relation between Author.books, Book.author, Book.editor;
// add @inverse to pair them (or @inverse none)
export type Book = {
  title: string;
  author: Author;
  editor?: Author;
};
```

[`@inverse`](/reference/tags/#inverse) names the field to pair with. In this example, a magazine has a `publisher` and a `printer`, both publishers; `@inverse publisher` pairs `magazines` with `publisher`, and `printer` stays a plain reference:

```ts title="entities/Publisher.ts"
import type { Magazine } from "./Magazine.ts";

export type Publisher = {
  name: string;
  /** @inverse publisher */
  magazines: Magazine[];
};
```

```ts title="entities/Magazine.ts"
import type { Publisher } from "./Publisher.ts";

export type Magazine = {
  title: string;
  publisher: Publisher;
  /** @onDelete setNull */
  printer?: Publisher;
};
```

- `@inverse` can go on either side. If both sides use it, they must name each other, or the build fails.
- `@inverse none` keeps a field unpaired even when it would pair automatically.

## Relation kinds

The kind follows from the two field types:

| Kind | Fields | Example |
| --- | --- | --- |
| 1-1 | single + single | `User.badge` and `Badge.holder` |
| 1-N | single + array | `Book.author` and `Author.books` |
| N-N | array + array | `Student.courses` and `Course.students` |

An optional single field means "zero or one" on that side; a required one means "exactly one".

### Storing and derived sides

Each relation is stored in one place, and the other side is **derived**, computed when it's read:

- **1-N:** the single field is a foreign key (`Book.author`); the array (`Author.books`) has no column and lists the related records by `createdAt`, then `id`.
- **1-1:** the field tagged [`@owner`](/reference/tags/#owner) stores a unique foreign key. Without `@owner`, the field of the entity whose name comes first alphabetically does. Both sides tagged `@owner` fail the build.
- **N-N:** a shared [join table](#join-tables) stores the links, with one position per side, so each side keeps its own order. Neither entity gets a column.

Derived sides look just like stored fields: they appear as ids in responses, take the same filters, can be [populated](/guides/populate/) and selected with `fields`, and have the same types and OpenAPI schema. Storage tags like `@unique` or `@index` on a derived side fail the build.

### Delete rules per side

Each side keeps its own [`@onDelete`](/reference/tags/#ondelete), applied when the record it points to is deleted. `Book.author` decides what happens to books when an author is deleted; `Author.books` decides what happens to an author when one of their books is deleted. The rules are the ones of [references](/guides/references/#delete-rules) and [reference arrays](/guides/reference-arrays/#delete-rules).

Both kinds of reference arrays, those stored in a column and N-N sides stored in a join table, refresh `updatedAt` on every remaining record a deleted record is removed from.

## 1-N: one author, many books

With the `Author` and `Book` entities above, create a book with its author:

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

After a second book, "Mort" (`01a1…bbf8`), the author lists both, in creation order:

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

### Writing from the derived side

Writing `Author.books` sets the `author` of each listed book. Adding "Mort" to another author moves it:

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

Books removed from the list lose their author: `author` becomes `null` when it's optional. Here it's required, so unlinking fails:

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

The derived array takes the [reference array filters](/guides/reference-arrays/#filters):

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

`Book.author` uses the default `restrict`, so an author with books can't be deleted:

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

### Self-relations

A relation between an entity and itself pairs only through `@inverse`:

```ts title="entities/Employee.ts"
export type Employee = {
  name: string;
  /** @onDelete setNull */
  manager?: Employee;
  /** @inverse manager */
  reports: Employee[];
};
```

With Rui and Lia created with Marta as their `manager`, Marta's `reports` lists them:

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

A field that names itself in `@inverse` fails the build.

## N-N: students and courses

```ts title="entities/Student.ts"
import type { Course } from "./Course.ts";

export type Student = {
  name: string;
  courses: Course[];
};
```

```ts title="entities/Course.ts"
import type { Student } from "./Student.ts";

export type Course = {
  title: string;
  students: Student[];
};
```

Algebra is `01a1…af72` and Biology is `01a1…77d4`. Ana enrolls in both:

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

Writing either side changes the shared links, and the other side sees it right away. Adding Bruno from the course:

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

Each side has its own order. Ana reorders her courses:

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

…and Algebra's students keep theirs:

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

`Student.courses` uses the default `pull`, so deleting Biology removes it from Ana's courses:

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

Ana lost a link, so she also gets a newer `updatedAt`.

## 1-1: users and badges

Each badge has at most one holder, and each user at most one badge. `@owner` makes `User.badge` the storing side (without it, `Badge.holder` would store the relation, since `Badge` comes first alphabetically):

```ts title="entities/User.ts"
import type { Badge } from "./Badge.ts";

export type User = {
  name: string;
  /** @owner @onConflict replace */
  badge?: Badge;
};
```

```ts title="entities/Badge.ts"
import type { User } from "./User.ts";

export type Badge = {
  code: string;
  holder?: User;
};
```

Ana takes the GOLD badge (`01a1…101e`):

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

### Conflicts and `@onConflict replace`

Linking a record that's already linked to another one fails with 409 `Value already exists`. With [`@onConflict replace`](/reference/tags/#onconflict) on the field you write, the link moves instead, and the previous holder's field becomes `null` (a required field fails with 409 instead). `User.badge` has it, so Bruno can take GOLD from Ana:

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

`Badge.holder` has no `@onConflict`, so giving the SILVER badge (`01a1…ea2d`) to Bruno, who already holds GOLD, fails:

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

Ana is free now, so she can take it from the badge's side:

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

## Consistency

A write from either side runs in one transaction with the main write, and refreshes the `updatedAt` of every record whose relation value changed. If anything fails, the whole request is rolled back. On MongoDB, this is why the server must run as a replica set.

## Join tables

An N-N relation is stored in one join table (a join collection on MongoDB and in memory) named `<table>__<field in snake_case>` after the entity whose name comes first alphabetically: `courses__students` for the example above. [`@joinTable`](/reference/tags/#jointable) on either side picks another name:

```ts title="entities/Team.ts"
import type { Player } from "./Player.ts";

export type Team = {
  name: string;
  /** @joinTable rosters */
  players: Player[];
};
```

```ts title="entities/Player.ts"
import type { Team } from "./Team.ts";

export type Player = {
  name: string;
  teams: Team[];
};
```

- Both sides may declare `@joinTable`, but only with the same name. Different names fail the build: `Course.students and Student.courses declare different @joinTable names (attendees and enrollments)`.
- 1-1 and 1-N relations have no join table, so `@joinTable` on them fails the build.
- The name must match `^[a-z][a-z0-9_]*$` and can't collide with an entity table or another join table in the same schema.
- When only the name changes, `migration add` generates a rename and keeps the links.

## Related reference

- Tags: [`@inverse`](/reference/tags/#inverse), [`@owner`](/reference/tags/#owner), [`@onConflict`](/reference/tags/#onconflict), [`@joinTable`](/reference/tags/#jointable), [`@onDelete`](/reference/tags/#ondelete)
- [Filter operators by field type](/reference/http/#filter-operators-by-field-type)
- [Error messages](/reference/errors/#messages)

Next: [Populate](/guides/populate/).
