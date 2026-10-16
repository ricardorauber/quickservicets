---
title: Arquivos e armazenamento
description: Envie arquivos, escolha onde eles ficam guardados, como os clientes chegam até eles e quando são apagados.
sidebar:
  order: 40
---

Arquivos são registros como quaisquer outros. Uma entidade de arquivo guarda os metadados do arquivo no banco e os bytes em um storage, e cada registro ganha uma `url` que os clientes usam para baixá-lo. O upload é feito com uma requisição multipart, direto na entidade de arquivo ou por qualquer entidade que a referencie.

## `File` e `Media` embutidas

Todo projeto tem duas entidades de arquivo, mesmo quando `entities/` não as define:

| Entidade | Rota | Aceita |
| --- | --- | --- |
| `File` | `/files` | qualquer tipo MIME (sujeito a `files.accept`) |
| `Media` | `/media` | apenas `image/*`, `video/*` e `audio/*` |

As duas têm os campos de sistema (`id`, `createdAt`, `updatedAt`) e mais:

| Campo | Descrição |
| --- | --- |
| `filename` | O nome base do arquivo enviado. O único campo base que um `PATCH` pode mudar. |
| `mimeType` | O tipo MIME da parte enviada. |
| `size` | Tamanho em bytes. |
| `storage` | Nome do storage que guarda os bytes. |
| `storageKey` | Onde o objeto fica no storage. Oculto: nunca aparece nas respostas. |
| `url` | Como baixar o arquivo. Calculada a cada leitura, nunca armazenada. |

Os outros campos base são somente leitura em corpos JSON:

```bash
curl -X PATCH localhost:3000/media/01a146d1-021f-737c-84f5-b476dc5cacc2 -d '{"size":1,"url":"x"}'
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"size","message":"Field is read-only"},{"field":"url","message":"Field is read-only"}]}}
```

Para referenciar um arquivo a partir de outra entidade, importe o tipo de `@quickservice/core`. Um campo simples vira uma referência, e um array vira um array de referências:

```ts check title="entities/Organization.ts"
import type { File, Media } from "@quickservice/core";

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

O resto desta página usa essa entidade.

## Estendendo `File` e `Media`

Para adicionar campos a uma entidade embutida, crie `entities/Media.ts` (ou `entities/File.ts`). Importe o tipo do core com outro nome e faça a interseção com os seus campos; não declare de novo os campos base:

```ts check title="entities/Media.ts"
import type { Media as BaseMedia } from "@quickservice/core";

export type Media = BaseMedia & {
  alt?: string;
};
```

Agora `alt` é aceito nos uploads e em `PATCH /media/<id>`, e aparece nas respostas.

Você também pode criar suas próprias entidades de arquivo. Toda entidade cujo tipo estende `File` ou `Media` (com `File & { ... }` ou `interface Document extends File`) ganha os campos base, a mesma regra de MIME da sua base e rotas próprias:

```ts check title="entities/Document.ts"
import type { File } from "@quickservice/core";

/** @access proxy @maxSize 5MB @accept application/pdf */
export type Document = File & {
  title?: string;
  pages?: number;
};
```

Isso cria `/documents`. As tags de entidade `@maxSize`, `@accept`, `@access` e `@storage` só funcionam em entidades de arquivo; em qualquer outra entidade, o build falha.

## Upload

`POST /<entidade-de-arquivo>` recebe `multipart/form-data` com os bytes em uma parte chamada `file`. Os outros campos vão em campos de formulário, convertidos para o tipo de cada campo:

```bash
curl -X POST localhost:3000/media -F "file=@logo.png;type=image/png" -F alt="Our logo"
```

```json
// 201 Created
{"id":"01a146d1-021f-737c-84f5-b476dc5cacc2","createdAt":"2026-10-16T22:24:25.121Z","updatedAt":"2026-10-16T22:24:25.121Z","filename":"logo.png","mimeType":"image/png","size":2048,"storage":"default","alt":"Our logo","url":"/media/01a146d1-021f-737c-84f5-b476dc5cacc2/file"}
```

Ou envie todos como JSON em uma parte chamada `data`:

```bash
curl -X POST localhost:3000/media -F "file=@photo.jpg;type=image/jpeg" -F 'data={"alt":"Team photo"};type=application/json'
```

```json
// 201 Created
{"id":"01a146d1-3b58-72d6-8ca9-3df8003fd225","createdAt":"2026-10-16T22:24:39.768Z","updatedAt":"2026-10-16T22:24:39.768Z","filename":"photo.jpg","mimeType":"image/jpeg","size":3000,"storage":"default","alt":"Team photo","url":"/media/01a146d1-3b58-72d6-8ca9-3df8003fd225/file"}
```

Um campo enviado das duas formas falha:

```bash
curl -X POST localhost:3000/media -F "file=@photo.jpg;type=image/jpeg" -F alt=x -F 'data={"alt":"y"}'
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"alt","message":"Duplicate field"}]}}
```

`filename` é o nome de arquivo da parte reduzido ao nome base (`../../etc/x.png` vira `x.png`), sem caracteres de controle e cortado em 255 caracteres. Os bytes são gravados primeiro e o registro é inserido depois; se a inserção falhar, o objeto gravado é apagado antes da resposta.

`PUT /<entidade-de-arquivo>/<id>` com um novo `file` substitui o conteúdo e mantém o `id`:

```bash
curl -X PUT localhost:3000/media/01a146d1-021f-737c-84f5-b476dc5cacc2 -F "file=@photo.jpg;type=image/jpeg" -F alt=Replaced
```

```json
// 200 OK
{"id":"01a146d1-021f-737c-84f5-b476dc5cacc2","createdAt":"2026-10-16T22:24:25.121Z","updatedAt":"2026-10-16T22:24:45.603Z","filename":"photo.jpg","mimeType":"image/jpeg","size":3000,"storage":"default","alt":"Replaced","url":"/media/01a146d1-021f-737c-84f5-b476dc5cacc2/file"}
```

### Tipo de conteúdo e arquivo ausente

`POST` e `PUT` em uma entidade de arquivo só aceitam multipart:

```bash
curl -X POST localhost:3000/media -H 'content-type: application/json' -d '{"filename":"a.png"}'
```

```json
// 415 Unsupported Media Type
{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Must be multipart/form-data"}}
```

Uma requisição multipart sem a parte `file` falha:

```bash
curl -X POST localhost:3000/media -F alt=x
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"file","message":"Is required"}]}}
```

### Limites de tamanho e de tipo

O maior upload permitido é o `@maxSize` da entidade, ou então `files.maxSize` na configuração (padrão 10 MB). Os tamanhos aceitam `B`, `KB`, `MB` ou `GB`, em base 1024. Um arquivo maior falha e nada é guardado:

```bash
curl -X POST localhost:3000/media -F "file=@big.png;type=image/png"   # 11 MB
```

```json
// 413 Payload Too Large
{"error":{"code":"PAYLOAD_TOO_LARGE","message":"File too large"}}
```

Os tipos aceitos são a lista `@accept` da entidade, ou então `files.accept` (padrão: qualquer um). Os padrões podem usar `*`, como `image/*`. `Media` e as entidades baseadas nela também ficam limitadas a imagens, vídeo e áudio:

```bash
curl -X POST localhost:3000/media -F "file=@contract.pdf;type=application/pdf"
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"file","message":"File type not allowed"}]}}
```

O mesmo arquivo vai para `/files` sem problema:

```bash
curl -X POST localhost:3000/files -F "file=@contract.pdf;type=application/pdf"
```

```json
// 201 Created
{"id":"01a146d1-3b9d-70bb-b990-71cdf5469789","createdAt":"2026-10-16T22:24:39.837Z","updatedAt":"2026-10-16T22:24:39.837Z","filename":"contract.pdf","mimeType":"application/pdf","size":5009,"storage":"default","url":"/files/01a146d1-3b9d-70bb-b990-71cdf5469789/file"}
```

## Upload por outras entidades

As rotas geradas `POST`, `PUT` e `PATCH` de qualquer entidade também aceitam multipart. Uma parte com o nome de um campo que referencia uma entidade de arquivo é enviada para essa entidade (com o storage, os limites e as regras de MIME dela), e o campo recebe o id do novo arquivo. Uma só requisição cria a organização, o logo, a galeria e o contrato:

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

`@maxSize` e `@accept` no campo valem além dos limites da própria entidade de destino, e os erros citam o campo:

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

As regras do campo também valem quando um valor JSON ou de formulário aponta o campo para o id de um arquivo existente. Uma parte cujo nome não é um campo de arquivo falha:

```bash
curl -X POST localhost:3000/organizations -F name=B -F slug=b -F "banner=@logo.png;type=image/png"
```

```json
// 400 Bad Request
{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"banner","message":"Unknown field"}]}}
```

Enviar um campo como arquivo e como valor falha com `Duplicate field`. Quando o registro não pode ser salvo, todo arquivo criado pela requisição é removido, então um conflito não deixa uploads soltos:

```bash
curl -X POST localhost:3000/organizations -F name=B -F slug=acme -F "logo=@logo.png;type=image/png"
```

```json
// 409 Conflict
{"error":{"code":"CONFLICT","message":"Value already exists","details":[{"field":"slug","message":"Value already exists"}]}}
```

Um `PATCH` com um novo arquivo substitui a referência:

```bash
curl -X PATCH localhost:3000/organizations/01a146d1-6966-767a-baae-9057ed75fca4 -F "logo=@photo.jpg;type=image/jpeg"
```

```json
// 200 OK
{"id":"01a146d1-6966-767a-baae-9057ed75fca4","createdAt":"2026-10-16T22:24:51.559Z","updatedAt":"2026-10-16T22:25:14.134Z","name":"Acme","slug":"acme","logo":"01a146d1-c194-70f5-8e7b-b9c8fc884a3b","contract":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","gallery":["01a146d1-6963-73f1-a7db-573cc20fcf31","01a146d1-6964-74bd-b5b6-f2a0121505e8"]}
```

O logo anterior é apagado (veja [Limpeza](#limpeza)).

### Arrays de arquivos

Repita uma parte para enviar vários arquivos para um array de referências; eles entram na ordem das partes. A lista resultante é:

- em `POST` e `PUT`: o valor do campo, se houver, seguido dos novos arquivos;
- em `PATCH` sem valor: a lista atual seguida dos novos arquivos;
- em `PATCH` com valor (uma lista completa, ou `{ "add", "remove" }`): esse resultado seguido dos novos arquivos.

Um `PATCH` com um arquivo o adiciona ao final:

```bash
curl -X PATCH localhost:3000/organizations/01a146d1-6966-767a-baae-9057ed75fca4 -F "gallery=@logo.png;type=image/png"
```

```json
// 200 OK
{"id":"01a146d1-6966-767a-baae-9057ed75fca4","createdAt":"2026-10-16T22:24:51.559Z","updatedAt":"2026-10-16T22:25:14.158Z","name":"Acme","slug":"acme","logo":"01a146d1-c194-70f5-8e7b-b9c8fc884a3b","contract":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","gallery":["01a146d1-6963-73f1-a7db-573cc20fcf31","01a146d1-6964-74bd-b5b6-f2a0121505e8","01a146d1-c1ac-7755-8a65-0a2c4150deba"]}
```

Uma lista em `data` mais um arquivo mantém só os itens listados e depois adiciona o novo; os itens removidos passam pela limpeza:

```bash
curl -X PATCH localhost:3000/organizations/01a146d1-6966-767a-baae-9057ed75fca4 \
  -F 'data={"gallery":["01a146d1-6964-74bd-b5b6-f2a0121505e8"]}' -F "gallery=@photo.jpg;type=image/jpeg"
```

```json
// 200 OK
{"id":"01a146d1-6966-767a-baae-9057ed75fca4","createdAt":"2026-10-16T22:24:51.559Z","updatedAt":"2026-10-16T22:25:14.173Z","name":"Acme","slug":"acme","logo":"01a146d1-c194-70f5-8e7b-b9c8fc884a3b","contract":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","gallery":["01a146d1-6964-74bd-b5b6-f2a0121505e8","01a146d1-c1bb-7141-a993-320dd0ec1995"]}
```

Cada arquivo precisa passar pelo `@maxSize` e pelo `@accept` do campo e do destino, com erros em `gallery[<índice>]`. `@maxTotalSize` limita a soma dos arquivos enviados ao campo em uma requisição (413 `Total upload size too large`), e `@minItems`/`@maxItems` valem para a lista resultante.

## Storages

Sem a chave `storage` na configuração, os arquivos vão para uma pasta local, `uploads/`, no projeto; é a configuração de todos os exemplos acima. Para escolher, passe em `storage` um mapa de storages com nome; ele precisa conter `default`:

```ts check title="quickservice.config.ts"
import { defineConfig, localStorage, sqliteAdapter } from "@quickservice/core";

export default defineConfig({
  database: sqliteAdapter({ path: process.env.DATABASE_PATH! }),
  storage: {
    default: localStorage({ dir: "uploads", publicBaseUrl: "https://cdn.example.com" }),
    archive: localStorage({ dir: "archive" }),
  },
});
```

- `localStorage({ dir, publicBaseUrl? })` grava dentro de `dir`, criando as pastas necessárias. `publicBaseUrl` é o endereço onde outra coisa (uma CDN, um servidor web) serve essa pasta.
- `s3Storage({ bucket, region?, endpoint?, accessKeyId?, secretAccessKey?, publicBaseUrl? })` funciona com AWS S3, Cloudflare R2, MinIO e outros serviços compatíveis com S3. Credenciais, região e endpoint omitidos são lidos de `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` e `S3_ENDPOINT` (ou das versões `AWS_*`).

```ts check
import { s3Storage } from "@quickservice/core";

export const archive = s3Storage({
  bucket: process.env.S3_BUCKET!,
  endpoint: "https://<account>.r2.cloudflarestorage.com",
});
```

Uma entidade de arquivo usa `default`, a menos que `@storage` indique outro, como em `/** @storage archive */`. Um nome que não está na configuração faz o build falhar.

Os objetos ficam em `<schema>/<collection>/<id>/<objectId><ext>`, por exemplo `media/01a146d1-021f-737c-84f5-b476dc5cacc2/01a146d1-0220-75a9-8ec6-4a0411d2c600.png` (não há segmento de schema para o schema padrão). Cada upload ganha um novo id de objeto, então substituir o conteúdo nunca sobrescreve o objeto anterior.

## O campo `url` e os modos de acesso

Todo registro de arquivo tem uma `url`, calculada a cada leitura (também em referências populadas). Como ela funciona depende do modo de acesso: a tag `@access` da entidade, ou então `files.access` na configuração, ou então `direct` quando o storage tem `publicBaseUrl` e `proxy` caso contrário.

### `direct`

`url` aponta direto para a URL pública do storage. A API nunca serve os bytes; quem serve é a sua CDN, o seu servidor web ou o bucket público. Com a configuração acima, `Media` usa o storage `default`, que tem `publicBaseUrl`:

```bash
curl -X POST localhost:3000/media -F "file=@logo.png;type=image/png"
```

```json
// 201 Created
{"id":"01a146d2-2b1f-7208-a081-a43e9114935a","createdAt":"2026-10-16T22:25:41.152Z","updatedAt":"2026-10-16T22:25:41.152Z","filename":"logo.png","mimeType":"image/png","size":2048,"storage":"default","alt":null,"url":"https://cdn.example.com/media/01a146d2-2b1f-7208-a081-a43e9114935a/01a146d2-2b1f-7209-9215-9cb450a1fd57.png"}
```

Neste modo não existe rota de arquivo:

```bash
curl localhost:3000/media/01a146d2-2b1f-7208-a081-a43e9114935a/file
```

```json
// 404 Not Found
{"error":{"code":"NOT_FOUND","message":"Route not found"}}
```

Quando uma entidade usa `direct` e o storage dela não tem `publicBaseUrl`, o build falha citando os dois.

### `proxy`

`url` é `/<rota>/<id>/file`, e a API transmite os bytes com `content-type`, `content-length` e `content-disposition`. Os hooks de `read` da entidade rodam antes, então os hooks que protegem `GET /documents/<id>` também protegem o arquivo. Defina `server.publicUrl` para ter URLs absolutas. Com `@access proxy` em `Document`:

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
x-request-id: 01a146d1-d5bf-7423-9aaf-dfe4cbdd9691
content-length: 5009

(os bytes do PDF)
```

### `signed`

`url` expira. Em um storage que assina URLs (`s3Storage`), ela é uma URL pré-assinada. Caso contrário, é a URL de proxy com `expires` (segundos unix) e uma `signature` HMAC-SHA256, feita com `files.signingSecret` ou com a variável de ambiente `FILES_SIGNING_SECRET`. `@access signed <segundos>` define a validade; o padrão é `files.signedUrlTtl` (900 segundos).

Mova `Document` para o storage `archive` e assine as URLs por 60 segundos, em `entities/Document.ts`:

```ts check
import type { File } from "@quickservice/core";

/** @storage archive @access signed 60 @maxSize 5MB @accept application/pdf */
export type Document = File & {
  title?: string;
  pages?: number;
};
```

Um storage local não assina, então sem um segredo o build falha:

```text
entities/Document.ts: entity Document uses signed file access, but storage "archive" cannot sign URLs and files.signingSecret is not set
```

Com `FILES_SIGNING_SECRET` no `.env`:

```bash
curl -X POST localhost:3000/documents -F "file=@contract.pdf;type=application/pdf" -F title=Signed
```

```json
// 201 Created
{"id":"01a146d2-2b32-757d-9f6d-a8620106da15","createdAt":"2026-10-16T22:25:41.171Z","updatedAt":"2026-10-16T22:25:41.171Z","filename":"contract.pdf","mimeType":"application/pdf","size":5009,"storage":"archive","title":"Signed","pages":null,"url":"/documents/01a146d2-2b32-757d-9f6d-a8620106da15/file?expires=1792189601&signature=6dfdbdee5355d62a0d5b8377c357936d6babd9bb527acd0e0c62604aa6d1d338"}
```

A URL funciona até expirar:

```bash
curl -i "localhost:3000/documents/01a146d2-2b32-757d-9f6d-a8620106da15/file?expires=1792189601&signature=6dfdbdee5355d62a0d5b8377c357936d6babd9bb527acd0e0c62604aa6d1d338"
```

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: inline; filename="contract.pdf"
x-request-id: 01a146d2-425e-74a2-b67c-ed7e0d7f64ef
content-length: 5009

(os bytes do PDF)
```

Uma assinatura ausente, alterada ou expirada é recusada:

```bash
curl "localhost:3000/documents/01a146d2-2b32-757d-9f6d-a8620106da15/file?expires=1792189999&signature=6dfdbdee5355d62a0d5b8377c357936d6babd9bb527acd0e0c62604aa6d1d338"
```

```json
// 403 Forbidden
{"error":{"code":"FORBIDDEN","message":"Invalid or expired signature"}}
```

No modo `signed`, a rota de arquivo não roda hooks: a assinatura é a única verificação, então quem consegue ler o registro pode compartilhar o arquivo até a URL expirar.

## Limpeza

Os objetos guardados são apagados quando nada mais os usa. Três flags da configuração, todas `true` por padrão, controlam isso:

| Flag | O que é apagado |
| --- | --- |
| `files.deleteOnRemove` | O objeto de um registro de arquivo apagado (`DELETE /media/<id>`). |
| `files.deleteReplaced` | O objeto antigo quando um `PUT` substitui o conteúdo de um arquivo, e o arquivo antigo (registro e objeto) quando uma referência muda ou sai de um array. |
| `files.deleteWithOwner` | Os arquivos que um registro referencia quando o registro é apagado. |

```ts check
import { defineConfig, memoryAdapter } from "@quickservice/core";

export default defineConfig({
  database: memoryAdapter(),
  files: { maxSize: "20MB", accept: ["image/*", "application/pdf"], deleteWithOwner: false },
});
```

`deleteReplaced` e `deleteWithOwner` pulam um arquivo que ainda é referenciado por outro registro de qualquer entidade. Os objetos só são apagados depois que as mudanças no banco são confirmadas; quando o storage falha, a resposta não muda e uma entrada `warn` com o storage e a chave vai para o log.

### `@keepFile`

`@keepFile` em um campo quer dizer que os arquivos dele nunca são apagados por causa deste registro, nem quando a referência muda nem quando o registro é apagado. Na `Organization` acima, apagar a organização remove o logo e a galeria, mas mantém o contrato:

```bash
curl -X DELETE localhost:3000/organizations/01a146d1-6966-767a-baae-9057ed75fca4
curl localhost:3000/files/01a146d1-6965-734d-9a39-ee2fba6e5b4d
curl localhost:3000/media/01a146d1-c194-70f5-8e7b-b9c8fc884a3b
```

```json
// 204 No Content (a exclusão)

// 200 OK (o contrato)
{"id":"01a146d1-6965-734d-9a39-ee2fba6e5b4d","createdAt":"2026-10-16T22:24:51.557Z","updatedAt":"2026-10-16T22:24:51.557Z","filename":"contract.pdf","mimeType":"application/pdf","size":5009,"storage":"default","url":"/files/01a146d1-6965-734d-9a39-ee2fba6e5b4d/file"}

// 404 Not Found (o logo)
{"error":{"code":"NOT_FOUND","message":"Media not found"}}
```

## Veja também

- [Tags](/pt-br/reference/tags/): `@maxSize`, `@accept`, `@access`, `@storage`, `@maxTotalSize` e `@keepFile`.
- [Configuração](/pt-br/reference/config/): as chaves `storage` e `files.*`.
- [Erros](/pt-br/reference/errors/): todos os status e mensagens.

Próximo: [Migrations](/pt-br/guides/migrations/).
