# syntax=docker/dockerfile:1
# Production image of the identity example. Build it from the repository root:
#   docker build -f examples/identity/Dockerfile -t identity .
# Each start applies the pending migrations, then starts the server in production mode:
#   docker run --rm -p 3000:3000 -e DATABASE_URL=postgres://postgres:postgres@host.docker.internal:5432/postgres identity

# 1. Install the example's dependencies (the CLI included: it applies the migrations) and run `quickservicets build`.
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY docs/package.json docs/
COPY packages/core packages/core
COPY packages/cli packages/cli
COPY examples/identity examples/identity
RUN bun install --frozen-lockfile --filter organizations
RUN cd examples/identity && bun run build

# 2. Runtime. NODE_ENV=production with PostgreSQL on Linux starts one server worker per CPU the container is given.
FROM oven/bun:1.4.2-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p examples/identity/uploads && chown -R bun:bun examples/identity/uploads
USER bun
WORKDIR /app/examples/identity
EXPOSE 3000
CMD ["sh", "-c", "bun run migrate && exec bun .generated/server.ts"]
