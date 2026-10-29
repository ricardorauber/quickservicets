# 0080 - The socket body limit follows the uploads the model really has

- Date: 2026-10-29
- Spec: 0878-file-and-media-entities-only-when-used
- Status: accepted

## Context
Spec 0878 builds the built-in `File` and `Media` entities only when something uses them. The `security` native sets
the socket's largest request body (`maxRequestBodySize`) to the largest body any route could accept: `limits.body`,
the routes' own `@limits body`, and the largest upload the model allows. Until now every model held `File` and
`Media`, so every service let bodies up to the default upload size (10 MB plus the form overhead) reach the app, and a
JSON body between `limits.body` and that size got the JSON `413` error of the body policy. Without file entities the
socket limit drops to `limits.body`, and Bun answers a larger body itself with an empty `413` before the app sees it.
The spec does not say which of the two to keep; a proxy test that relied on the 10 MB allowance showed the difference.

## Options considered
- A: Keep the rule as designed: the socket refuses what no route could accept, now computed from the entities really
  in the model. Services without uploads hold less memory per request; a body above every limit gets Bun's empty
  `413`, as bodies above the upload size always did.
- B: Keep a socket allowance of the default upload size even without file entities, so bodies up to it still get the
  JSON error: the old behavior, but every service accepts 10 MB bodies at the socket that no route can use.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
No code change in the `security` native. A service without uploads refuses a body above `limits.body` (and above
every route's own limit) at the socket with an empty `413`; within the limits, or with a larger global limit than a
route's, the body policy answers the JSON `413` as before. The proxy test that checked a route's `maxBodySize` sets a
global limit above the route's, so the route's own limit is the one that refuses the body.
