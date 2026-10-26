# Uploading files with an entity

> An entity with a logo and a photo gallery, created and changed with multipart requests, with size and type limits per field.

**The problem:** an organization has a logo and a photo gallery. You want clients to send the organization and its images in one request, with limits on size and type, and to get back URLs they can show.

**The solution:** reference the built-in `Media` file entity from the fields, add limits with field tags, and send `multipart/form-data` to the generated routes. Each file part named after a field is stored, becomes a `Media` record, and its id goes into the field.

## The entity

```ts title="entities/Organization.ts"
import type { Media } from "@quickservicets/core";

export type Organization = {
  name: string;
  /** @unique */
  slug: string;
  /** @maxSize 1MB @accept image/png,image/jpeg */
  logo?: Media;
  /** @maxItems 6 @maxSize 2MB @maxTotalSize 8MB @accept image/* */
  gallery?: Media[];
};
```

- `logo?: Media` is a reference to one `Media` record; `gallery?: Media[]` is an ordered reference array.
- [`@maxSize`](/reference/tags/#maxsize-1) and [`@accept`](/reference/tags/#accept-1) on a field add to the limits of `Media` itself, which only takes `image/*`, `video/*` and `audio/*` and at most [`files.maxSize`](/reference/config/) (10 MB by default).
- [`@maxTotalSize`](/reference/tags/#maxtotalsize) caps the files sent to `gallery` in one request, and `@maxItems` the length of the whole list.

No other code is needed: the generated `POST`, `PATCH` and `PUT` routes accept JSON or multipart. With the default config, files go to a local storage in `uploads/` and are served by the API, so `url` is `/media/<id>/file`.

## Create with files

Text fields are form fields (converted by their type), and each file part is named after its field. Repeat `gallery` once per photo; the order of the parts is the order of the list.

```bash
curl -i -X POST localhost:3000/organizations \
  -F name=Acme -F slug=acme \
  -F "logo=@logo.png" \
  -F "gallery=@office.jpg" -F "gallery=@team.jpg"
```

```txt
HTTP/1.1 201 Created

{"name":"Acme","slug":"acme","logo":"01a146db-3155-73aa-8dc4-89702ca56a0d","gallery":["01a146db-3157-73c8-b034-e956d2ea7dff","01a146db-3157-73ca-87cd-21fa7c702320"],"id":"01a146db-315b-71ee-86ab-5822b87ac46b","createdAt":"2026-10-16T22:35:32.572Z","updatedAt":"2026-10-16T22:35:32.572Z"}
```

`logo` and `gallery` hold ids. Ask for the records with `populate` to get the file details and `url`:

```bash
curl "localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b?populate=logo,gallery"
```

```json
{
  "id": "01a146db-315b-71ee-86ab-5822b87ac46b",
  "createdAt": "2026-10-16T22:35:32.572Z",
  "updatedAt": "2026-10-16T22:35:32.572Z",
  "name": "Acme",
  "slug": "acme",
  "logo": {
    "id": "01a146db-3155-73aa-8dc4-89702ca56a0d",
    "createdAt": "2026-10-16T22:35:32.566Z",
    "updatedAt": "2026-10-16T22:35:32.566Z",
    "filename": "logo.png",
    "mimeType": "image/png",
    "size": 4096,
    "storage": "default",
    "url": "/media/01a146db-3155-73aa-8dc4-89702ca56a0d/file"
  },
  "gallery": [
    {
      "id": "01a146db-3157-73c8-b034-e956d2ea7dff",
      "createdAt": "2026-10-16T22:35:32.567Z",
      "updatedAt": "2026-10-16T22:35:32.567Z",
      "filename": "office.jpg",
      "mimeType": "image/jpeg",
      "size": 524288,
      "storage": "default",
      "url": "/media/01a146db-3157-73c8-b034-e956d2ea7dff/file"
    },
    {
      "id": "01a146db-3157-73ca-87cd-21fa7c702320",
      "createdAt": "2026-10-16T22:35:32.571Z",
      "updatedAt": "2026-10-16T22:35:32.571Z",
      "filename": "team.jpg",
      "mimeType": "image/jpeg",
      "size": 786432,
      "storage": "default",
      "url": "/media/01a146db-3157-73ca-87cd-21fa7c702320/file"
    }
  ]
}
```

The `url` serves the file (here saved to `logo-copy.png`, printing the headers):

```bash
curl -s -D - -o logo-copy.png localhost:3000/media/01a146db-3155-73aa-8dc4-89702ca56a0d/file
```

```txt
HTTP/1.1 200 OK
content-type: image/png
content-length: 4096
content-disposition: inline; filename="logo.png"
```

## Change the files

`PATCH` takes multipart too. A new `logo` part replaces the logo, and the old `Media` record and its file are deleted, because nothing else uses them ([`files.deleteReplaced`](/reference/config/)):

```bash
curl -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -F "logo=@logo-2026.png"
```

```json
{"name":"Acme","slug":"acme","logo":"01a146db-315e-74c1-8abc-98fa70e09302","gallery":["01a146db-3157-73c8-b034-e956d2ea7dff","01a146db-3157-73ca-87cd-21fa7c702320"],"id":"01a146db-315b-71ee-86ab-5822b87ac46b","createdAt":"2026-10-16T22:35:32.572Z","updatedAt":"2026-10-16T22:35:32.575Z"}
```

```bash
curl localhost:3000/media/01a146db-3155-73aa-8dc4-89702ca56a0d
```

```json
{"error":{"code":"NOT_FOUND","message":"Media not found"}}
```

On a `PATCH`, `gallery` parts are added to the end of the current list:

```bash
curl -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -F "gallery=@party.jpg"
```

```json
{"name":"Acme","slug":"acme","logo":"01a146db-315e-74c1-8abc-98fa70e09302","gallery":["01a146db-3157-73c8-b034-e956d2ea7dff","01a146db-3157-73ca-87cd-21fa7c702320","01a146db-3161-71c2-94d0-359f7228e2b3"],"id":"01a146db-315b-71ee-86ab-5822b87ac46b","createdAt":"2026-10-16T22:35:32.572Z","updatedAt":"2026-10-16T22:35:32.577Z"}
```

To remove photos while adding others, send the change as JSON in a `data` part: `{ "remove": [...] }` (or `add`, or the full list) is applied first, then the new files are appended:

```bash
curl -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b \
  -F 'data={"gallery":{"remove":["01a146db-3157-73c8-b034-e956d2ea7dff"]}}' \
  -F "gallery=@lobby.jpg"
```

```json
{"name":"Acme","slug":"acme","logo":"01a146db-315e-74c1-8abc-98fa70e09302","gallery":["01a146db-3157-73ca-87cd-21fa7c702320","01a146db-3161-71c2-94d0-359f7228e2b3","01a146db-3162-71a2-8e7b-8af5f26c6a15"],"id":"01a146db-315b-71ee-86ab-5822b87ac46b","createdAt":"2026-10-16T22:35:32.572Z","updatedAt":"2026-10-16T22:35:32.578Z"}
```

The removed photo is deleted like the old logo was.

## When a file breaks a rule

Each limit answers with the [standard error body](/reference/errors/), naming the field. A 2 MB logo is over its `@maxSize 1MB`:

```bash
curl -i -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -F "logo=@big-logo.png"
```

```txt
HTTP/1.1 413 Payload Too Large

{"error":{"code":"PAYLOAD_TOO_LARGE","message":"File too large","details":[{"field":"logo","message":"File too large"}]}}
```

A GIF is not in the logo's `@accept`:

```bash
curl -i -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -F "logo=@logo.gif"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"logo","message":"File type not allowed"}]}}
```

Errors in an array name the item. Here the second file is a PDF:

```bash
curl -i -X POST localhost:3000/organizations -F name=Beta -F slug=beta \
  -F "gallery=@office.jpg" -F "gallery=@brochure.pdf"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"gallery[1]","message":"File type not allowed"}]}}
```

Five 2 MB photos are within each file's limit, but over `@maxTotalSize 8MB` together:

```bash
curl -i -X POST localhost:3000/organizations -F name=Beta -F slug=beta \
  -F "gallery=@1.jpg" -F "gallery=@2.jpg" -F "gallery=@3.jpg" -F "gallery=@4.jpg" -F "gallery=@5.jpg"
```

```txt
HTTP/1.1 413 Payload Too Large

{"error":{"code":"PAYLOAD_TOO_LARGE","message":"Total upload size too large","details":[{"field":"gallery","message":"Total upload size too large"}]}}
```

When a request fails, for any reason, the files it stored are removed, so nothing is left behind.

## Variations

**Upload first, then reference by id.** Upload to the `Media` routes on their own (the part is named `file`), then send the id as JSON. The field's limits still apply to the referenced file.

```bash
curl -X POST localhost:3000/media -F "file=@logo-dark.png"
```

```json
{"filename":"logo-dark.png","mimeType":"image/png","size":4096,"storage":"default","id":"01a146db-3167-73fe-bc5b-1fe2c4d0ee35","createdAt":"2026-10-16T22:35:32.584Z","updatedAt":"2026-10-16T22:35:32.584Z","url":"/media/01a146db-3167-73fe-bc5b-1fe2c4d0ee35/file"}
```

```bash
curl -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b \
  -d '{"logo":"01a146db-3167-73fe-bc5b-1fe2c4d0ee35"}'
```

```json
{"name":"Acme","slug":"acme","logo":"01a146db-3167-73fe-bc5b-1fe2c4d0ee35","gallery":["01a146db-3157-73ca-87cd-21fa7c702320","01a146db-3161-71c2-94d0-359f7228e2b3","01a146db-3162-71a2-8e7b-8af5f26c6a15"],"id":"01a146db-315b-71ee-86ab-5822b87ac46b","createdAt":"2026-10-16T22:35:32.572Z","updatedAt":"2026-10-16T22:35:32.584Z"}
```

Referencing an existing file that breaks the field's rules fails the same way, here a 3 MB image uploaded to `/media` earlier, set as the logo:

```bash
curl -i -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -d '{"logo":"01a146db-3169-7715-918e-725daeaa6890"}'
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"logo","message":"File too large"}]}}
```

**From a browser.** Build a `FormData` with the same names; `fetch` sets the multipart boundary itself, so do not set `content-type`:

```ts title="web/create-organization.ts"
export async function createOrganization(name: string, slug: string, logo: File, photos: File[]) {
  const form = new FormData();
  form.append("name", name);
  form.append("slug", slug);
  form.append("logo", logo);
  for (const photo of photos) form.append("gallery", photo);
  const response = await fetch("http://localhost:3000/organizations", { method: "POST", body: form });
  if (!response.ok) throw new Error(((await response.json()) as { error: { message: string } }).error.message);
  return (await response.json()) as { id: string; logo: string; gallery: string[] };
}
```

**All fields as JSON.** Instead of one form field per value, send `-F 'data={"name":"Acme","slug":"acme"}'` with the file parts. A field sent in both `data` and its own part is rejected:

```bash
curl -i -X POST localhost:3000/organizations -F 'data={"name":"Gamma","slug":"gamma"}' -F name=X
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"name","message":"Duplicate field"}]}}
```

**Keep the old files.** Tag a field `@keepFile` to never delete the files it referenced when they are replaced or the organization is deleted. Turn the cleanup off for the whole project with `files.deleteReplaced` and `files.deleteWithOwner`.

**Public or signed URLs.** Give the storage a public URL (`localStorage({ dir: "uploads", publicBaseUrl: "https://cdn.example.com" })`) and `url` points straight at it; tag a file entity `@access signed 60` for links that expire. Set `server.publicUrl` for absolute URLs instead of `/media/...`.

**Your own file entity.** `export type Logo = Media & { alt?: string }` in `entities/Logo.ts` is a file entity with its own routes, limits (`@maxSize`, `@accept` on the type) and storage (`@storage`); reference it as `logo?: Logo`.

## Related

- [JSDoc tags](/reference/tags/): `@maxSize`, `@accept`, `@maxTotalSize`, `@keepFile`, `@access`, `@storage`.
- [Configuration](/reference/config/): `storage`, `files.*` and `server.publicUrl`.
- [Errors](/reference/errors/): `File too large`, `Total upload size too large`, `Must be multipart/form-data`.
- [HTTP query parameters](/reference/http/): `populate`.

Next: [Pagination in custom endpoints](/recipes/pagination/).
