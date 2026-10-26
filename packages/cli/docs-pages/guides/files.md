# Files and storage

> Upload files, choose where they are stored, how clients reach them and when they are deleted.

Files are records like any other. A file entity stores the file's metadata in the database and its bytes in a storage, and every record gets a `url` that clients use to download it. You upload with a multipart request, either to the file entity itself or through any entity that references it.

## Built-in `File` and `Media`

Every project has two file entities, even when `entities/` does not define them:

| Entity | Route | Accepts |
| --- | --- | --- |
| `File` | `/files` | any MIME type (subject to `files.accept`) |
| `Media` | `/media` | only `image/*`, `video/*` and `audio/*` |

Both have the system fields (`id`, `createdAt`, `updatedAt`) plus:

| Field | Description |
| --- | --- |
| `filename` | The uploaded file's base name. The only base field a `PATCH` can change. |
| `mimeType` | The MIME type of the uploaded file, decided as in [File type](#file-type). |
| `size` | Size in bytes. |
| `storage` | Name of the storage that holds the bytes. |
| `storageKey` | Where the object lives in the storage. Hidden: never in responses. |
| `url` | How to download the file. Computed on every read, never stored. |

The other base fields are read-only in JSON bodies:

```bash
curl -X PATCH localhost:3000/media/01a146d1-021f-737c-84f5-b476dc5cacc2 -d '{"size":1,"url":"x"}'
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"size","message":"Field is read-only"},{"field":"url","message":"Field is read-only"}]}}
```

To reference a file from another entity, import the type from `@quickservicets/core`. A single field becomes a reference, an array becomes a reference array:

```ts title="entities/Organization.ts"
import type { File, Media } from "@quickservicets/core";

export type Organization = {
  name: string;
  /** @unique */
  slug: string;
  /** @maxSize 1MB @accept image/png,image/jpeg */
  logo?: Media;
  /** @maxItems 5 @maxTotalSize 5MB */
  gallery?: Media[];
  /** @keepFile */
  contract?: File;
};
```

The rest of this page uses this entity.

## Extending `File` and `Media`

To add fields to a built-in entity, create `entities/Media.ts` (or `entities/File.ts`). Import the core type under another name and intersect it with your fields; do not redeclare the base fields:

```ts title="entities/Media.ts"
import type { Media as BaseMedia } from "@quickservicets/core";

export type Media = BaseMedia & {
  alt?: string;
};
```

`alt` is now accepted on uploads and `PATCH /media/<id>`, and shown in responses.

You can also create your own file entities. Any entity whose type extends `File` or `Media` (with `File & { ... }` or `interface Document extends File`) gets the base fields, the same MIME rule as its base and its own routes:

```ts title="entities/Document.ts"
import type { File } from "@quickservicets/core";

/** @access proxy @maxSize 5MB @accept application/pdf */
export type Document = File & {
  title?: string;
  pages?: number;
};
```

This creates `/documents`. The entity tags `@maxSize`, `@accept`, `@access` and `@storage` work only on file entities; on any other entity the build fails.

## Uploading

`POST /<file-entity>` takes `multipart/form-data` with the bytes in a part named `file`. Other fields go in form fields, converted to the field's type:

```bash
curl -X POST localhost:3000/media -F "file=@logo.png;type=image/png" -F alt="Our logo"
```

```json
// 201 Created
{"id":"01a146d1-021f-737c-84f5-b476dc5cacc2","createdAt":"2026-10-16T22:24:25.121Z","updatedAt":"2026-10-16T22:24:25.121Z","filename":"logo.png","mimeType":"image/png","size":2048,"storage":"default","alt":"Our logo","url":"/media/01a146d1-021f-737c-84f5-b476dc5cacc2/file"}
```

Or send them all as JSON in one part named `data`:

```bash
curl -X POST localhost:3000/media -F "file=@photo.jpg;type=image/jpeg" -F 'data={"alt":"Team photo"};type=application/json'
```

```json
// 201 Created
{"id":"01a146d1-3b58-72d6-8ca9-3df8003fd225","createdAt":"2026-10-16T22:24:39.768Z","updatedAt":"2026-10-16T22:24:39.768Z","filename":"photo.jpg","mimeType":"image/jpeg","size":3000,"storage":"default","alt":"Team photo","url":"/media/01a146d1-3b58-72d6-8ca9-3df8003fd225/file"}
```

A field sent both ways fails:

```bash
curl -X POST localhost:3000/media -F "file=@photo.jpg;type=image/jpeg" -F alt=x -F 'data={"alt":"y"}'
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"alt","message":"Duplicate field"}]}}
```

`filename` is the part's file name reduced to its base name (`../../etc/x.png` becomes `x.png`), without control characters and cut to 255 characters. The bytes are stored first and the record inserted after; when the insert fails, the stored object is deleted before the response.

`PUT /<file-entity>/<id>` with a new `file` replaces the content and keeps the `id`:

```bash
curl -X PUT localhost:3000/media/01a146d1-021f-737c-84f5-b476dc5cacc2 -F "file=@photo.jpg;type=image/jpeg" -F alt=Replaced
```

```json
// 200 OK
{"id":"01a146d1-021f-737c-84f5-b476dc5cacc2","createdAt":"2026-10-16T22:24:25.121Z","updatedAt":"2026-10-16T22:24:45.603Z","filename":"photo.jpg","mimeType":"image/jpeg","size":3000,"storage":"default","alt":"Replaced","url":"/media/01a146d1-021f-737c-84f5-b476dc5cacc2/file"}
```

### Content type and missing file

`POST` and `PUT` on a file entity only take multipart:

```bash
curl -X POST localhost:3000/media -H 'content-type: application/json' -d '{"filename":"a.png"}'
```

```json
// 415 Unsupported Media Type
{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Must be multipart/form-data"}}
```

A multipart request without a `file` part fails:

```bash
curl -X POST localhost:3000/media -F alt=x
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"file","message":"Is required"}]}}
```

### Size and type limits

The largest upload is the entity's `@maxSize`, else `files.maxSize` in the config (default 10 MB). Sizes take `B`, `KB`, `MB` or `GB`, in base 1024. A larger file fails and nothing is kept:

```bash
curl -X POST localhost:3000/media -F "file=@big.png;type=image/png"   # 11 MB
```

```json
// 413 Payload Too Large
{"error":{"code":"PAYLOAD_TOO_LARGE","message":"File too large"}}
```

The accepted types are the entity's `@accept` list, else `files.accept` (default any). Patterns may use `*`, like `image/*`. `Media` and the entities based on it are also limited to images, video and audio:

```bash
curl -X POST localhost:3000/media -F "file=@contract.pdf;type=application/pdf"
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"file","message":"File type not allowed"}]}}
```

The same file goes to `/files` without trouble:

```bash
curl -X POST localhost:3000/files -F "file=@contract.pdf;type=application/pdf"
```

```json
// 201 Created
{"id":"01a146d1-3b9d-70bb-b990-71cdf5469789","createdAt":"2026-10-16T22:24:39.837Z","updatedAt":"2026-10-16T22:24:39.837Z","filename":"contract.pdf","mimeType":"application/pdf","size":5009,"storage":"default","url":"/files/01a146d1-3b9d-70bb-b990-71cdf5469789/file"}
```

### File type

The type of an upload is decided from its bytes when the server recognizes the format, so a file name or a declared type cannot get a file past `@accept`. The declared type is the `Content-Type` header of the part, as the client sent it; the file name plays no part. With curl, set it with `;type=`.

The server recognizes these formats from their content:

- PNG (`image/png`), JPEG (`image/jpeg`), GIF (`image/gif`), WebP (`image/webp`) and PDF (`application/pdf`);
- ZIP (`application/zip`), and among ZIP files DOCX (`application/vnd.openxmlformats-officedocument.wordprocessingml.document`) and XLSX (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`);
- MP4 (`video/mp4`), WebM (`video/webm`) and MP3 (`audio/mpeg`).

Then:

| Content | Declared type | Type used |
| --- | --- | --- |
| A recognized format | The same type (parameters and case are ignored) | The detected type |
| A recognized format | Missing or `application/octet-stream` | The detected type |
| A recognized format | A compatible type (see below) | The declared type |
| A recognized format | Any other type | None: the upload fails with 415 |
| Any other content | Anything | The declared type |

The compatible types are `audio/mp4` for MP4 and `audio/webm` for WebM, and any type for a ZIP file that is not DOCX or XLSX, since many formats are ZIP files (`.pptx`, `.odt`, `.epub`).

`@accept`, the stored `mimeType` and the `content-type` of the [file route](#proxy) all use that type. PNG bytes sent without a type are stored as `image/png`:

```bash
curl -X POST localhost:3000/media -F "file=@logo.png;type=application/octet-stream"
```

```json
// 201 Created
{"id":"01a146d1-021f-737c-84f5-b476dc5cacc2","createdAt":"2026-10-16T22:24:25.121Z","updatedAt":"2026-10-16T22:24:25.121Z","filename":"logo.png","mimeType":"image/png","size":2048,"storage":"default","alt":null,"url":"/media/01a146d1-021f-737c-84f5-b476dc5cacc2/file"}
```

PNG bytes declared as another type fail, whatever the file name. The error names the field and both types:

```bash
curl -X POST localhost:3000/organizations -F name=D -F slug=d -F "logo=@logo.png;type=image/gif"
```

```json
// 415 Unsupported Media Type
{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"File content does not match its type","details":[{"field":"logo","message":"Detected image/png, declared image/gif"}]}}
```

A format the server does not recognize, such as CSV, keeps its declared type: `-F "file=@items.csv;type=text/csv"` is stored as `text/csv`.

## Uploading through other entities

The generated `POST`, `PUT` and `PATCH` routes of any entity also take multipart. A part named after a reference field to a file entity is uploaded into that entity (with its storage, limits and MIME rules), and the field is set to the new file's id. One request creates the organization, its logo, its gallery and its contract:

```bash
curl -X POST localhost:3000/organizations \
  -F name=Acme -F slug=acme \
  -F "logo=@logo.png;type=image/png" \
  -F "gallery=@logo.png;type=image/png" -F "gallery=@photo.jpg;type=image/jpeg" \
  -F "contract=@contract.pdf;type=application/pdf"
```

```json
// 201 Created
{"id":"01a146d1-6966-767a-baae-9057ed75fca4","createdAt":"2026-10-16T22:24:51.559Z","updatedAt":"2026-10-16T22:24:51.559Z","name":"Acme","slug":"acme","logo":"01a146d1-6961-707a-8846-34aa8af81699","contract":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","gallery":["01a146d1-6963-73f1-a7db-573cc20fcf31","01a146d1-6964-74bd-b5b6-f2a0121505e8"]}
```

`@maxSize` and `@accept` on the field apply on top of the target entity's own limits, and the errors name the field:

```bash
curl -X POST localhost:3000/organizations -F name=B -F slug=b -F "logo=@two-mb.png;type=image/png"
```

```json
// 413 Payload Too Large
{"error":{"code":"PAYLOAD_TOO_LARGE","message":"File too large","details":[{"field":"logo","message":"File too large"}]}}
```

```bash
curl -X POST localhost:3000/organizations -F name=C -F slug=c -F "logo=@anim.gif;type=image/gif"
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"logo","message":"File type not allowed"}]}}
```

The field rules also apply when a JSON or form value sets the field to the id of an existing file. A part whose name is not a file field fails:

```bash
curl -X POST localhost:3000/organizations -F name=B -F slug=b -F "banner=@logo.png;type=image/png"
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"banner","message":"Unknown field"}]}}
```

Sending a field as a file and as a value fails with `Duplicate field`. When the record cannot be saved, every file the request created is removed, so a conflict leaves no stray uploads:

```bash
curl -X POST localhost:3000/organizations -F name=B -F slug=acme -F "logo=@logo.png;type=image/png"
```

```json
// 409 Conflict
{"error":{"code":"CONFLICT","message":"Value already exists","details":[{"field":"slug","message":"Value already exists"}]}}
```

`PATCH` with a new file replaces the reference:

```bash
curl -X PATCH localhost:3000/organizations/01a146d1-6966-767a-baae-9057ed75fca4 -F "logo=@photo.jpg;type=image/jpeg"
```

```json
// 200 OK
{"id":"01a146d1-6966-767a-baae-9057ed75fca4","createdAt":"2026-10-16T22:24:51.559Z","updatedAt":"2026-10-16T22:25:14.134Z","name":"Acme","slug":"acme","logo":"01a146d1-c194-70f5-8e7b-b9c8fc884a3b","contract":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","gallery":["01a146d1-6963-73f1-a7db-573cc20fcf31","01a146d1-6964-74bd-b5b6-f2a0121505e8"]}
```

The previous logo is deleted (see [Cleanup](#cleanup)).

### Arrays of files

Repeat a part to upload several files into a reference array; they are added in part order. The resulting list is:

- on `POST` and `PUT`: the field's value, if any, followed by the new files;
- on `PATCH` without a value: the current list followed by the new files;
- on `PATCH` with a value (a full list, or `{ "add", "remove" }`): that result followed by the new files.

A `PATCH` with one file appends it:

```bash
curl -X PATCH localhost:3000/organizations/01a146d1-6966-767a-baae-9057ed75fca4 -F "gallery=@logo.png;type=image/png"
```

```json
// 200 OK
{"id":"01a146d1-6966-767a-baae-9057ed75fca4","createdAt":"2026-10-16T22:24:51.559Z","updatedAt":"2026-10-16T22:25:14.158Z","name":"Acme","slug":"acme","logo":"01a146d1-c194-70f5-8e7b-b9c8fc884a3b","contract":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","gallery":["01a146d1-6963-73f1-a7db-573cc20fcf31","01a146d1-6964-74bd-b5b6-f2a0121505e8","01a146d1-c1ac-7755-8a65-0a2c4150deba"]}
```

A list in `data` plus a file keeps only the listed items, then adds the new one; the removed items are cleaned up:

```bash
curl -X PATCH localhost:3000/organizations/01a146d1-6966-767a-baae-9057ed75fca4 \
  -F 'data={"gallery":["01a146d1-6964-74bd-b5b6-f2a0121505e8"]}' -F "gallery=@photo.jpg;type=image/jpeg"
```

```json
// 200 OK
{"id":"01a146d1-6966-767a-baae-9057ed75fca4","createdAt":"2026-10-16T22:24:51.559Z","updatedAt":"2026-10-16T22:25:14.173Z","name":"Acme","slug":"acme","logo":"01a146d1-c194-70f5-8e7b-b9c8fc884a3b","contract":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","gallery":["01a146d1-6964-74bd-b5b6-f2a0121505e8","01a146d1-c1bb-7141-a993-320dd0ec1995"]}
```

Each file must pass the field's and the target's `@maxSize` and `@accept`, with errors at `gallery[<index>]`. `@maxTotalSize` limits the sum of the files uploaded to the field in one request (413 `Total upload size too large`), and `@minItems`/`@maxItems` apply to the resulting list.

## Storages

Without a `storage` key in the config, files go to a local folder, `uploads/`, in the project; that is the setup of every example above. To choose, give `storage` a map of named storages; it must contain `default`:

```ts title="quickservicets.config.ts"
import { defineConfig, localStorage, sqliteAdapter } from "@quickservicets/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  storage: {
    default: localStorage({ dir: "uploads", publicBaseUrl: "https://cdn.example.com" }),
    archive: localStorage({ dir: "archive" }),
  },
});
```

- `localStorage({ dir, publicBaseUrl? })` writes under `dir`, creating folders as needed. `publicBaseUrl` is the address where something else (a CDN, a web server) serves that folder.
- `s3Storage({ bucket, region?, endpoint?, accessKeyId?, secretAccessKey?, publicBaseUrl? })` works with AWS S3, Cloudflare R2, MinIO and other S3-compatible services. Credentials, region and endpoint left out are read from `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` and `S3_ENDPOINT` (or their `AWS_*` versions).

```ts
import { s3Storage } from "@quickservicets/core";

export const archive = s3Storage({
  bucket: process.env.S3_BUCKET!,
  endpoint: "https://<account>.r2.cloudflarestorage.com",
});
```

A file entity uses `default` unless `@storage` names another one, as in `/** @storage archive */`. A name missing from the config fails the build.

Objects are stored at `<schema>/<collection>/<id>/<objectId><ext>`, for example `media/01a146d1-021f-737c-84f5-b476dc5cacc2/01a146d1-0220-75a9-8ec6-4a0411d2c600.png` (there is no schema segment for the default schema). Each upload gets a new object id, so replacing content never overwrites the previous object.

## The `url` field and access modes

Every file record has a `url`, computed on every read (also in populated references). How it works depends on the access mode: the entity's `@access` tag, else `files.access` in the config, else `direct` when the storage has a `publicBaseUrl` and `proxy` otherwise.

### `direct`

`url` points straight at the storage's public URL. The API never serves the bytes; your CDN, web server or public bucket does. With the config above, `Media` uses the `default` storage, which has a `publicBaseUrl`:

```bash
curl -X POST localhost:3000/media -F "file=@logo.png;type=image/png"
```

```json
// 201 Created
{"id":"01a146d2-2b1f-7208-a081-a43e9114935a","createdAt":"2026-10-16T22:25:41.152Z","updatedAt":"2026-10-16T22:25:41.152Z","filename":"logo.png","mimeType":"image/png","size":2048,"storage":"default","alt":null,"url":"https://cdn.example.com/media/01a146d2-2b1f-7208-a081-a43e9114935a/01a146d2-2b1f-7209-9215-9cb450a1fd57.png"}
```

There is no file route in this mode:

```bash
curl localhost:3000/media/01a146d2-2b1f-7208-a081-a43e9114935a/file
```

```json
// 404 Not Found
{"error":{"code":"NOT_FOUND","message":"Route not found"}}
```

When an entity uses `direct` and its storage has no `publicBaseUrl`, the build fails naming both.

### `proxy`

`url` is `/<route>/<id>/file`, and the API streams the bytes with `content-type`, `content-length` and `content-disposition`. The entity's `read` hooks run first, so the hooks that guard `GET /documents/<id>` also guard its file. Set `server.publicUrl` to get absolute URLs. With `@access proxy` on `Document`:

```bash
curl -X POST localhost:3000/documents -F "file=@contract.pdf;type=application/pdf" -F title=Contract -F pages=3
```

```json
// 201 Created
{"id":"01a146d1-3baa-7648-8192-63c793f3371d","createdAt":"2026-10-16T22:24:39.851Z","updatedAt":"2026-10-16T22:24:39.851Z","filename":"contract.pdf","mimeType":"application/pdf","size":5009,"storage":"default","title":"Contract","pages":3,"url":"/documents/01a146d1-3baa-7648-8192-63c793f3371d/file"}
```

```bash
curl -i localhost:3000/documents/01a146d1-3baa-7648-8192-63c793f3371d/file
```

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: inline; filename="contract.pdf"
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
x-request-id: 01a146d1-d5bf-7423-9aaf-dfe4cbdd9691
content-length: 5009

(the PDF bytes)
```

The `files` item of the security native keeps a browser from running an uploaded file as a page of the service: every file response carries `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, and types a browser could run (HTML, SVG, XML, JavaScript and CSS, listed in `security.files.attachmentTypes`) are sent with `Content-Disposition: attachment`. `security: { files: false }` sends the plain headers above. Files in `direct` mode are served by the storage or CDN, which needs the same headers set there (see [Security](/guides/security/)).

### `signed`

`url` expires. On a storage that signs URLs (`s3Storage`), it is a presigned URL. Otherwise it is the proxy URL with `expires` (unix seconds) and an HMAC-SHA256 `signature`, made with `files.signingSecret` or the `FILES_SIGNING_SECRET` environment variable. `@access signed <ttlSeconds>` sets the lifetime; the default is `files.signedUrlTtl` (900 seconds).

Move `Document` to the `archive` storage and sign its URLs for 60 seconds, in `entities/Document.ts`:

```ts
import type { File } from "@quickservicets/core";

/** @storage archive @access signed 60 @maxSize 5MB @accept application/pdf */
export type Document = File & {
  title?: string;
  pages?: number;
};
```

A local storage cannot sign, so without a secret the build fails:

```text
entities/Document.ts: entity Document uses signed file access, but storage "archive" cannot sign URLs and files.signingSecret is not set
```

With `FILES_SIGNING_SECRET` in `.env`:

```bash
curl -X POST localhost:3000/documents -F "file=@contract.pdf;type=application/pdf" -F title=Signed
```

```json
// 201 Created
{"id":"01a146d2-2b32-757d-9f6d-a8620106da15","createdAt":"2026-10-16T22:25:41.171Z","updatedAt":"2026-10-16T22:25:41.171Z","filename":"contract.pdf","mimeType":"application/pdf","size":5009,"storage":"archive","title":"Signed","pages":null,"url":"/documents/01a146d2-2b32-757d-9f6d-a8620106da15/file?expires=1792189601&signature=6dfdbdee5355d62a0d5b8377c357936d6babd9bb527acd0e0c62604aa6d1d338"}
```

The URL works until it expires:

```bash
curl -i "localhost:3000/documents/01a146d2-2b32-757d-9f6d-a8620106da15/file?expires=1792189601&signature=6dfdbdee5355d62a0d5b8377c357936d6babd9bb527acd0e0c62604aa6d1d338"
```

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: inline; filename="contract.pdf"
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
x-request-id: 01a146d2-425e-74a2-b67c-ed7e0d7f64ef
content-length: 5009

(the PDF bytes)
```

A missing, changed or expired signature is refused:

```bash
curl "localhost:3000/documents/01a146d2-2b32-757d-9f6d-a8620106da15/file?expires=1792189999&signature=6dfdbdee5355d62a0d5b8377c357936d6babd9bb527acd0e0c62604aa6d1d338"
```

```json
// 403 Forbidden
{"error":{"code":"FORBIDDEN","message":"Invalid or expired signature"}}
```

In `signed` mode the file route runs no hooks: the signature is the only check, so whoever can read the record can share its file until the URL expires.

## Cleanup

Stored objects are deleted when nothing uses them anymore. Three config flags, all `true` by default, control it:

| Flag | What gets deleted |
| --- | --- |
| `files.deleteOnRemove` | The object of a file record that is deleted (`DELETE /media/<id>`). |
| `files.deleteReplaced` | The old object when `PUT` replaces a file's content, and the old file (record and object) when a reference changes or leaves an array. |
| `files.deleteWithOwner` | The files a record references when the record is deleted. |

```ts
import { defineConfig, memoryAdapter } from "@quickservicets/core";

export default defineConfig({
  database: memoryAdapter(),
  files: { maxSize: "20MB", accept: ["image/*", "application/pdf"], deleteWithOwner: false },
});
```

`deleteReplaced` and `deleteWithOwner` skip a file that another record of any entity still references. Objects are deleted only after the database changes commit; when the storage fails, the response does not change and a `warn` entry naming the storage and key is logged.

### `@keepFile`

`@keepFile` on a field means its files are never deleted because of this record, neither when the reference changes nor when the record is deleted. In the `Organization` above, deleting the organization removes its logo and gallery but keeps the contract:

```bash
curl -X DELETE localhost:3000/organizations/01a146d1-6966-767a-baae-9057ed75fca4
curl localhost:3000/files/01a146d1-6965-734d-9a39-ee2fba6e5b4d
curl localhost:3000/media/01a146d1-c194-70f5-8e7b-b9c8fc884a3b
```

```json
// 204 No Content (the delete)

// 200 OK (the contract)
{"id":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","createdAt":"2026-10-16T22:24:51.557Z","updatedAt":"2026-10-16T22:24:51.557Z","filename":"contract.pdf","mimeType":"application/pdf","size":5009,"storage":"default","url":"/files/01a146d1-6965-734d-9a39-ee2fba6e5b4d/file"}

// 404 Not Found (the logo)
{"error":{"code":"NOT_FOUND","message":"Media not found"}}
```

## See also

- [Tags](/reference/tags/): `@maxSize`, `@accept`, `@access`, `@storage`, `@maxTotalSize` and `@keepFile`.
- [Configuration](/reference/config/): the `storage` and `files.*` keys.
- [Errors](/reference/errors/): every status and message.
- [Security](/guides/security/): the headers of served files, and what files in `direct` mode need from the storage or CDN.

Next: [Migrations](/guides/migrations/).
