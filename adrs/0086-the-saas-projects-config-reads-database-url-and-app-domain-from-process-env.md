# 0086 - The saas-projects config reads DATABASE_URL and APP_DOMAIN from process.env

- Date: 2026-11-02
- Spec: 0283-saas-projects-showcase-tenants-and-plans
- Status: accepted

## Context
Spec 0283 R1 writes the showcase's config as `postgresAdapter({ url: env.DATABASE_URL })` and `domain: env.APP_DOMAIN`.
`env` can only be read once a configuration has resolved: reading it at the top level of `quickservicets.config.ts`
throws `env.DATABASE_URL was read before the configuration was resolved; use process.env inside
quickservicets.config.ts` (spec 0140), so the config as written cannot load.

## Options considered
- A: Read both from `process.env` in the config, with local defaults, as every other example does (ADRs 0081 and
  0083), keeping the template of tenant databases a secret reference, `secret("env://TENANT_DATABASE_TEMPLATE")`.
- B: Make the database URL a secret reference too, `secret("env://DATABASE_URL")`: it works, but it departs further
  from the spec's config and needs the secrets native for every command that connects.
- C: Let `env` be read in the config: changes spec 0140's rule for every project.

## Decision
The user asked to follow the recommended option for every open decision automatically; option A was recommended.

## Consequences
`examples/saas-projects/quickservicets.config.ts` reads `process.env.DATABASE_URL` and `process.env.APP_DOMAIN` with
defaults for local runs; the tenant database template stays `secret("env://TENANT_DATABASE_TEMPLATE")`, so the
`secrets` native is enabled in the config.
