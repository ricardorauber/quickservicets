# syntax=docker/dockerfile:1
# Plain Bun benchmark stack. Build from this folder:
#   docker build -t qsbench-bun benchmarks/stacks/bun

# 1. Bundle and minify the launcher and the worker (no dependencies besides Bun itself).
FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
COPY package.json ./
COPY src src
RUN bun build src/launcher.ts src/server.ts --target=bun --production --outdir dist

# 2. Runtime: the same Bun image QuickService.ts runs on, with the two bundled files.
FROM oven/bun:1.4.2-alpine
ENV NODE_ENV=production PORT=8080 UPLOAD_DIR=/data/uploads WORKERS=2
WORKDIR /app
COPY --from=build /app/dist dist
RUN mkdir -p /data/uploads && chown -R bun:bun /data
USER bun
EXPOSE 8080
CMD ["bun", "dist/launcher.js"]
