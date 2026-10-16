---
title: Upload de arquivos com uma entidade
description: Uma entidade com logo e galeria de fotos, criada e alterada com requisições multipart, com limites de tamanho e tipo por campo.
sidebar:
  order: 11
---

**O problema:** uma organização tem um logo e uma galeria de fotos. Você quer que os clientes enviem a organização e suas imagens em uma requisição, com limites de tamanho e tipo, e recebam de volta URLs que possam exibir.

**A solução:** referencie nos campos a entidade de arquivo `Media`, que já vem pronta, adicione limites com tags de campo e envie `multipart/form-data` para as rotas geradas. Cada parte de arquivo com o nome de um campo é armazenada, vira um registro `Media`, e seu id vai para o campo.

## A entidade

```ts check title="entities/Organization.ts"
import type { Media } from "@quickservice/core";

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

- `logo?: Media` é uma referência a um registro `Media`; `gallery?: Media[]` é um array de referências ordenado.
- [`@maxSize`](/pt-br/reference/tags/#maxsize-1) e [`@accept`](/pt-br/reference/tags/#accept-1) em um campo somam-se aos limites do próprio `Media`, que só aceita `image/*`, `video/*` e `audio/*` e no máximo [`files.maxSize`](/pt-br/reference/config/) (10 MB por padrão).
- [`@maxTotalSize`](/pt-br/reference/tags/#maxtotalsize) limita os arquivos enviados a `gallery` em uma requisição, e `@maxItems` o tamanho da lista inteira.

Nenhum outro código é necessário: as rotas geradas `POST`, `PATCH` e `PUT` aceitam JSON ou multipart. Com a configuração padrão, os arquivos vão para um storage local em `uploads/` e são servidos pela API, então `url` é `/media/<id>/file`.

## Criar com arquivos

Campos de texto são campos de formulário (convertidos pelo seu tipo), e cada parte de arquivo leva o nome do seu campo. Repita `gallery` uma vez por foto; a ordem das partes é a ordem da lista.

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

`logo` e `gallery` guardam ids. Peça os registros com `populate` para obter os detalhes dos arquivos e a `url`:

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

A `url` serve o arquivo (aqui salvo em `logo-copy.png`, mostrando os cabeçalhos):

```bash
curl -s -D - -o logo-copy.png localhost:3000/media/01a146db-3155-73aa-8dc4-89702ca56a0d/file
```

```txt
HTTP/1.1 200 OK
content-type: image/png
content-length: 4096
content-disposition: inline; filename="logo.png"
```

## Alterar os arquivos

`PATCH` também aceita multipart. Uma nova parte `logo` substitui o logo, e o registro `Media` antigo e seu arquivo são apagados, porque nada mais os usa ([`files.deleteReplaced`](/pt-br/reference/config/)):

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

Em um `PATCH`, partes `gallery` são adicionadas ao fim da lista atual:

```bash
curl -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -F "gallery=@party.jpg"
```

```json
{"name":"Acme","slug":"acme","logo":"01a146db-315e-74c1-8abc-98fa70e09302","gallery":["01a146db-3157-73c8-b034-e956d2ea7dff","01a146db-3157-73ca-87cd-21fa7c702320","01a146db-3161-71c2-94d0-359f7228e2b3"],"id":"01a146db-315b-71ee-86ab-5822b87ac46b","createdAt":"2026-10-16T22:35:32.572Z","updatedAt":"2026-10-16T22:35:32.577Z"}
```

Para remover fotos enquanto adiciona outras, envie a mudança como JSON em uma parte `data`: `{ "remove": [...] }` (ou `add`, ou a lista completa) é aplicado primeiro, e depois os arquivos novos são acrescentados:

```bash
curl -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b \
  -F 'data={"gallery":{"remove":["01a146db-3157-73c8-b034-e956d2ea7dff"]}}' \
  -F "gallery=@lobby.jpg"
```

```json
{"name":"Acme","slug":"acme","logo":"01a146db-315e-74c1-8abc-98fa70e09302","gallery":["01a146db-3157-73ca-87cd-21fa7c702320","01a146db-3161-71c2-94d0-359f7228e2b3","01a146db-3162-71a2-8e7b-8af5f26c6a15"],"id":"01a146db-315b-71ee-86ab-5822b87ac46b","createdAt":"2026-10-16T22:35:32.572Z","updatedAt":"2026-10-16T22:35:32.578Z"}
```

A foto removida é apagada, como o logo antigo foi.

## Quando um arquivo quebra uma regra

Cada limite responde com o [corpo de erro padrão](/pt-br/reference/errors/), nomeando o campo. Um logo de 2 MB passa do seu `@maxSize 1MB`:

```bash
curl -i -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -F "logo=@big-logo.png"
```

```txt
HTTP/1.1 413 Payload Too Large

{"error":{"code":"PAYLOAD_TOO_LARGE","message":"File too large","details":[{"field":"logo","message":"File too large"}]}}
```

Um GIF não está no `@accept` do logo:

```bash
curl -i -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -F "logo=@logo.gif"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"logo","message":"File type not allowed"}]}}
```

Erros em um array nomeiam o item. Aqui o segundo arquivo é um PDF:

```bash
curl -i -X POST localhost:3000/organizations -F name=Beta -F slug=beta \
  -F "gallery=@office.jpg" -F "gallery=@brochure.pdf"
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"gallery[1]","message":"File type not allowed"}]}}
```

Cinco fotos de 2 MB respeitam o limite de cada arquivo, mas juntas passam de `@maxTotalSize 8MB`:

```bash
curl -i -X POST localhost:3000/organizations -F name=Beta -F slug=beta \
  -F "gallery=@1.jpg" -F "gallery=@2.jpg" -F "gallery=@3.jpg" -F "gallery=@4.jpg" -F "gallery=@5.jpg"
```

```txt
HTTP/1.1 413 Payload Too Large

{"error":{"code":"PAYLOAD_TOO_LARGE","message":"Total upload size too large","details":[{"field":"gallery","message":"Total upload size too large"}]}}
```

Quando uma requisição falha, por qualquer motivo, os arquivos que ela armazenou são removidos, então nada fica para trás.

## Variações

**Enviar primeiro, depois referenciar pelo id.** Envie às rotas de `Media` diretamente (a parte se chama `file`) e depois mande o id em JSON. Os limites do campo continuam valendo para o arquivo referenciado.

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

Referenciar um arquivo existente que quebra as regras do campo falha do mesmo jeito, aqui uma imagem de 3 MB enviada antes a `/media`, usada como logo:

```bash
curl -i -X PATCH localhost:3000/organizations/01a146db-315b-71ee-86ab-5822b87ac46b -d '{"logo":"01a146db-3169-7715-918e-725daeaa6890"}'
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"logo","message":"File too large"}]}}
```

**Do navegador.** Monte um `FormData` com os mesmos nomes; o `fetch` define o boundary do multipart sozinho, então não defina `content-type`:

```ts check title="web/create-organization.ts"
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

**Todos os campos em JSON.** Em vez de um campo de formulário por valor, envie `-F 'data={"name":"Acme","slug":"acme"}'` com as partes de arquivo. Um campo enviado em `data` e também na sua própria parte é rejeitado:

```bash
curl -i -X POST localhost:3000/organizations -F 'data={"name":"Gamma","slug":"gamma"}' -F name=X
```

```txt
HTTP/1.1 400 Bad Request

{"error":{"code":"VALIDATION_ERROR","message":"Invalid body","details":[{"field":"name","message":"Duplicate field"}]}}
```

**Manter os arquivos antigos.** Marque um campo com `@keepFile` para nunca apagar os arquivos que ele referenciava quando forem substituídos ou a organização for apagada. Desligue a limpeza no projeto inteiro com `files.deleteReplaced` e `files.deleteWithOwner`.

**URLs públicas ou assinadas.** Dê ao storage uma URL pública (`localStorage({ dir: "uploads", publicBaseUrl: "https://cdn.example.com" })`) e `url` aponta direto para ela; marque uma entidade de arquivo com `@access signed 60` para links que expiram. Defina `server.publicUrl` para URLs absolutas em vez de `/media/...`.

**Sua própria entidade de arquivo.** `export type Logo = Media & { alt?: string }` em `entities/Logo.ts` é uma entidade de arquivo com rotas, limites (`@maxSize`, `@accept` no tipo) e storage (`@storage`) próprios; referencie-a como `logo?: Logo`.

## Relacionados

- [Tags JSDoc](/pt-br/reference/tags/): `@maxSize`, `@accept`, `@maxTotalSize`, `@keepFile`, `@access`, `@storage`.
- [Configuração](/pt-br/reference/config/): `storage`, `files.*` e `server.publicUrl`.
- [Erros](/pt-br/reference/errors/): `File too large`, `Total upload size too large`, `Must be multipart/form-data`.
- [Parâmetros de query HTTP](/pt-br/reference/http/): `populate`.

Próxima: [Paginação em endpoints próprios](/pt-br/recipes/pagination/).
