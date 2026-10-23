# === build: install deps + compile all packages ===
# Build context: vibesrcs/sibserver/
FROM node:22-alpine AS build
ARG http_proxy
ARG https_proxy
RUN apk add --no-cache python3 make g++ && corepack enable && corepack prepare pnpm@11.4.0 --activate
WORKDIR /app

# Layer 1: package manifests → pnpm install (cached by lockfile)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile

# Layer 2: source → build all packages
COPY packages/ packages/
RUN pnpm -r build

# === sibs: API server runtime ===
FROM node:22-alpine AS sibs
WORKDIR /app
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/server/dist /app/dist
ENV NODE_ENV=production PORT=7420
EXPOSE 7420
CMD ["node", "/app/dist/api/server.js"]
