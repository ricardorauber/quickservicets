# HTTP query parameters

> Paging, sorting, filters, field selection and populate on generated routes.

The generated list route (`GET /<collection>`) takes every parameter below; the read route (`GET /<collection>/<id>`) takes `fields`, `exclude` and `populate`. Unknown or repeated parameters fail with 400.

| Parameter | Description |
| --- | --- |
| `limit` | Page size, 1–100 (default 20). |
| `offset` | Records to skip, 0 or more (default 0). |
| `sort` | Comma-separated fields; prefix `-` for descending (default `-createdAt`, then `-id`). |
| `where[<field>][<op>]` | Filters, combined with AND; `in`, `nin`, `containsAny` and `containsAll` take up to 100 comma-separated values. |
| `fields` | Comma-separated paths to return (list and read). |
| `exclude` | Comma-separated paths to leave out (list and read). |
| `populate` | Comma-separated reference paths to replace with records, up to `populate.maxDepth` segments. |

## Filter operators by field type

| Type | Operators |
| --- | --- |
| `id` | `eq`, `ne`, `in`, `nin`, `exists`, `isNull` |
| `ref` | `eq`, `ne`, `in`, `nin`, `exists`, `isNull` |
| `boolean` | `eq`, `ne`, `in`, `nin`, `exists`, `isNull` |
| `enum` | `eq`, `ne`, `in`, `nin`, `exists`, `isNull` |
| `string` | `eq`, `ne`, `in`, `nin`, `exists`, `isNull`, `contains`, `startsWith` |
| `number` | `eq`, `ne`, `in`, `nin`, `exists`, `isNull`, `gt`, `gte`, `lt`, `lte` |
| `date` | `eq`, `ne`, `in`, `nin`, `exists`, `isNull`, `gt`, `gte`, `lt`, `lte` |
| `refArray` | `contains`, `containsAny`, `containsAll`, `size`, `isEmpty` |

## What each operator means

- `eq`: equals
- `ne`: differs from
- `in`: is one of
- `nin`: is none of
- `gt`: greater than
- `gte`: greater than or equal
- `lt`: less than
- `lte`: less than or equal
- `contains`: contains (case-insensitive; on reference arrays, holds the id)
- `startsWith`: starts with (case-insensitive)
- `exists`: has a value (`true`/`false`)
- `isNull`: is null (`true`/`false`)
- `containsAny`: holds any of the ids
- `containsAll`: holds all the ids
- `size`: has a number of items (`[size][gte]=2`)
- `isEmpty`: has no items (`true`/`false`)
