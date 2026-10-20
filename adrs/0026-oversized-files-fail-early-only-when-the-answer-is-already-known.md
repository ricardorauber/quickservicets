# 0026 - An oversized file fails while the body is read only when no earlier rule could answer first

- Date: 2026-10-19
- Spec: 0122-single-pass-multipart
- Status: accepted

## Context
Spec 0122 R3 asks for the upload limits to be enforced while the multipart body is read, "before the whole file is
buffered when possible", while malformed bodies and every upload rule keep answering the same errors. The upload
rules run in a fixed order after parsing: a missing `file` part (400), a content type that does not match the declared
one (415), then the size (413) and the accepted types; entity uploads first check the `data` part and duplicate
fields, which may come later in the body. Stopping at the first oversized byte would change which error wins.

## Options considered
- A: Stop reading only when the answer is already decided — for the `file` part of a file entity (the first part named
  `file`), once it passes the entity's size limit and its first 64 bytes are in, run the 415 check on those bytes and
  answer 415 or 413; ZIP-based files (whose exact format needs the end of the file) and entity uploads keep the current
  order after the whole body. The only visible change: an oversized file followed by a malformed rest of the body
  answers 413 instead of the parse error.
- B: Stop at the first byte past any limit — earliest refusal, but a file both oversized and of the wrong type, or an
  entity upload with an invalid `data` part, would answer a different error than today.
- C: Keep reading the whole body first — no early refusal at all, so R3's "while reading" is not met.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`readMultipart()` in `packages/core/src/files/upload.ts` takes an optional limit, checked by `MultipartReader`
(`packages/core/src/files/multipart.ts`) as chunks arrive; `parseUpload()` passes the file entity's size limit and a
check built from `detectHeadType()`/`isZipHead()` in `detect.ts`. When the check fails, the request body stream is
cancelled.
