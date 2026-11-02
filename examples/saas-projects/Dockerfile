# syntax=docker/dockerfile:1
# Production image of the saas-projects showcase. Build it from the repository root:
#   docker build -f examples/saas-projects/Dockerfile -t saas-projects .
# Each start migrates the service's database and every workspace, then starts the server in production mode.

# 1. Install the showcase's dependencies (the CLI included: it applies the migrations) and run `quickservicets build`.
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY docs/package.json docs/
COPY packages/core packages/core
COPY packages/cli packages/cli
COPY examples/saas-projects examples/saas-projects
RUN bun install --frozen-lockfile --filter saas-projects
RUN cd examples/saas-projects && bun run build

# 2. Runtime.
FROM oven/bun:1.4.2-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
USER bun
WORKDIR /app/examples/saas-projects
EXPOSE 3000
CMD ["sh", "-c", "bun run migrate && exec bun .generated/server.ts"]
