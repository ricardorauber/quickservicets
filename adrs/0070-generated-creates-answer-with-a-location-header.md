# 0070 - Generated create routes answer with a Location header

- Date: 2026-10-27
- Spec: 0232-tenancy-feature-and-tenant-resolution
- Status: accepted

## Context
Spec 0232 R2 says the `path` source removes the tenant prefix before routing "so `location` headers of generated
routes keep the prefix", and AC3 expects the `location` header of `POST /t/acme/posts` to start with `/t/acme/posts/`.
The generated routes did not send a `Location` header at all, so there was no header to keep.

## Options considered
- A: Generated create routes answer 201 with `Location: <the called path>/<id>`, built from the URL the client called,
  so a prefix removed before routing stays in it without any rewriting. Standard REST, small, and tenancy needs nothing
  extra.
- B: The tenancy native adds the header itself after a generated create: tenancy-only behavior, and clients of
  services without tenancy see a different create response.
- C: Leave the header out and leave AC3 unchecked: the spec's intent is lost.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
Every generated `POST` of an entity answers with a `Location` header naming the new record's item route (with the
tenant prefix when the client used one). Custom endpoints are unchanged.
