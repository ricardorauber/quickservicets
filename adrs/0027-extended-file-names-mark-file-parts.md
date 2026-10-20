# 0027 - A part with `filename*` is a file part, and `filename*` wins over `filename`

- Date: 2026-10-19
- Spec: 0122-single-pass-multipart
- Status: accepted

## Context
Spec 0122 R2 asks the multipart parser to handle `filename*` (RFC 5987), and R1 to produce the same fields and files
as the runtime's form parser did. That parser treats a part with only `filename*` as a plain text field (so its upload
failed with "Is required") and ignores `filename*` when `filename` is also present.

## Options considered
- A: Follow RFC 7578 and RFC 6266 — a part with `filename` or `filename*` is a file part; the decoded `filename*`
  (UTF-8 or ISO-8859-1) is its name and wins over `filename`; an undecodable value falls back to `filename`, or to the
  raw value. Uploads from clients that send only `filename*` start to work.
- B: Keep the runtime's behavior — `filename*` alone makes a text field, which R2 says must be handled.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`MultipartReader` in `packages/core/src/files/multipart.ts` reads both parameters; a part with only `filename*` becomes
a `File` named after the decoded value. Every other part keeps the type and name the runtime's parser gave it, except
that an empty `filename=""` names the file `""`, as the HTML form encoding does.
