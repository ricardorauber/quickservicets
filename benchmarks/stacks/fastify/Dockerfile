# syntax=docker/dockerfile:1
# Fastify benchmark service. Build context: this folder.

# 1. Production dependencies from the lockfile.
FROM node:24.21.0-alpine3.23 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 2. Runtime: Node, the dependencies and the sources (plain JavaScript, no build step).
FROM node:24.21.0-alpine3.23
ENV NODE_ENV=production PORT=8080 UPLOAD_DIR=/data/uploads WEB_CONCURRENCY=2
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
