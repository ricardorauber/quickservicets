# References and delete rules

> Point a field to a record of another entity, and choose what happens when that record is deleted.

A field typed with another entity is a **reference**: it stores the id of one record of that entity. QuickService.ts checks that the record exists on every write and, when the referenced record is deleted, applies the field's `@onDelete` rule.

## Declaring a reference

Import the other entity's type and use it as the field type:

```ts title="entities/Organization.ts"
export type Organization = {
  name: string;
};
```

```ts title="entities/User.ts"
import type { Organization } from "./Organization.ts";

export type User = {
  email: string;
  organization: Organization;
};
```

In requests and responses, `organization` is the organization's id, a string. A reference can be optional (`organization?: Organization`), and then it also accepts `null`. An entity can reference itself, as in the [self-reference example](#self-references) below.

References are only supported as top-level fields. An entity type inside a nested object or an array of objects fails the build:

```ts
// entities/User.ts: field "meta.owner" references an entity, which is only supported in top-level fields
export type User = {
  meta: { owner: Organization };
};
```

To hold several records, use a list of the entity type instead (`members: User[]`). That's a reference array, covered in [Reference arrays](/guides/reference-arrays/).

## Existence checks

Creating, updating or replacing a record checks that every reference points to a record that exists. A missing one fails with 400, naming the field:

```http
POST /users
Content-Type: application/json

{
  "email": "ana@acme.co",
  "organization": "01a1…beef"
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
        "field": "organization",
        "message": "Referenced record not found"
      }
    ]
  }
}
```

With the id of an organization that exists, the user is created:

```http
POST /users
Content-Type: application/json

{
  "email": "ana@acme.co",
  "organization": "01a1…e3eb"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "email": "ana@acme.co",
  "organization": "01a1…e3eb",
  "id": "01a1…1e6b",
  "createdAt": "2026-10-16T22:34:07.833Z",
  "updatedAt": "2026-10-16T22:34:07.833Z"
}
```

Reference fields take the `eq`, `ne`, `in`, `nin`, `exists` and `isNull` filters, so you can list the users of one organization:

```http
GET /users?where[organization][eq]=01a1…e3eb&fields=email
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [
    {
      "email": "ana@acme.co"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

To get the organization itself instead of its id, use [populate](/guides/populate/).

## Delete rules

`@onDelete` on a reference field says what happens to **this** record when the record it points to is deleted:

| Value | When the referenced record is deleted |
| --- | --- |
| `restrict` (default) | The delete fails with 409 while this record points to it. |
| `cascade` | This record is deleted too. |
| `setNull` | This field becomes `null`. Only for optional fields. |

The examples below use the `Organization` and `User` entities above, plus a `Post` and a `Comment` that both point to a user.

### `restrict`

`User.organization` has no `@onDelete`, so it uses `restrict`. While Ana belongs to Acme, Acme can't be deleted:

```http
DELETE /organizations/01a1…e3eb
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": {
    "code": "CONFLICT",
    "message": "Cannot delete: referenced by users"
  }
}
```

The message names the collection that blocks the delete (`Cannot delete: referenced by <collection>`), and nothing is deleted. Delete or move the users first, then delete the organization.

### `cascade`

A post can't exist without its author, so deleting the author deletes the post:

```ts title="entities/Post.ts"
import type { User } from "./User.ts";

export type Post = {
  title: string;
  /** @onDelete cascade */
  author: User;
};
```

### `setNull`

A comment can outlive its author, so the reference is optional and becomes `null`:

```ts title="entities/Comment.ts"
import type { User } from "./User.ts";

export type Comment = {
  text: string;
  /** @onDelete setNull */
  author?: User;
};
```

Ana has written a post (`01a1…2ae2`) and a comment (`01a1…5175`). Deleting her applies both rules at once:

```http
DELETE /users/01a1…1e6b
```

```http
HTTP/1.1 204 No Content
```

The post was deleted with her:

```http
GET /posts/01a1…2ae2
```

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": {
    "code": "NOT_FOUND",
    "message": "Post not found"
  }
}
```

The comment is still there, without an author, and its `updatedAt` moved forward:

```http
GET /comments/01a1…5175
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "01a1…5175",
  "createdAt": "2026-10-16T22:34:07.834Z",
  "updatedAt": "2026-10-16T22:34:07.835Z",
  "text": "Nice post",
  "author": null
}
```

`setNull` on a required field, or any other value, fails the build:

```ts
// entities/Comment.ts: field "author" must be optional to use @onDelete setNull
export type Comment = {
  /** @onDelete setNull */
  author: User;
};
```

### How a delete is planned

Before changing anything, a delete collects every record it affects, following `cascade` through as many levels as needed. If any of those records is still pointed to by a `restrict` reference, the whole delete fails with 409 and nothing changes. Otherwise the cascades, the `setNull` updates and the delete itself run in one transaction. This works the same on every database.

## Self-references

With a self-reference and `cascade`, deleting a category deletes its whole subtree:

```ts title="entities/Category.ts"
export type Category = {
  name: string;
  /** @onDelete cascade */
  parent?: Category;
};
```

```http
POST /categories
Content-Type: application/json

{
  "name": "Fiction",
  "parent": "01a1…76a0"
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "name": "Fiction",
  "parent": "01a1…76a0",
  "id": "01a1…1a3b",
  "createdAt": "2026-10-16T22:34:07.835Z",
  "updatedAt": "2026-10-16T22:34:07.835Z"
}
```

With "Fantasy" created under "Fiction", deleting "Books" (`01a1…76a0`) removes all three:

```http
DELETE /categories/01a1…76a0
```

```http
HTTP/1.1 204 No Content
```

```http
GET /categories
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "data": [],
  "total": 0,
  "limit": 20,
  "offset": 0
}
```

Cycles are handled too: a record is never planned twice, so the delete always ends.

> **Tip:**
>
> When two entities point to each other (for example `User.organization` and `Organization.users`), they form one [bidirectional relation](/guides/relations/). Each side keeps its own `@onDelete`.

## Related reference

- [`@onDelete`](/reference/tags/#ondelete) in the tags reference
- [Filter operators by field type](/reference/http/#filter-operators-by-field-type)
- [Error messages](/reference/errors/#messages), including `Referenced record not found` and `Cannot delete: referenced by <collection>`

Next: [Reference arrays](/guides/reference-arrays/).
