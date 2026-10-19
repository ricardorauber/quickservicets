# syntax=docker/dockerfile:1
# Express benchmark stack. Build context: this folder.
#   docker build -t qsbench-express benchmarks/stacks/express

# 1. Production dependencies only, from the lockfile.
FROM node:24.21.0-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 2. Runtime: Node.js, the dependencies and the sources (plain JavaScript, nothing to compile).
FROM node:24.21.0-alpine3.24
ENV NODE_ENV=production PORT=8080 WORKERS=2 UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src src
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
